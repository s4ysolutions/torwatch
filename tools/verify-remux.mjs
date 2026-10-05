// verify-remux: check the in-browser MKV→fMP4 pipeline against ffmpeg.
//
//   node tools/verify-remux.mjs <file.mkv> [seekSec]
//
// Runs the real pipeline (MkvDemuxer + createMsePlayer) in node against a
// recording MediaSource, writes what each SourceBuffer received to an .mp4,
// then has ffmpeg decode it and compares every decoded frame (md5 + time)
// with decoding the MKV directly. A browser decoder is stricter than
// ffmpeg about container details (sample entry size, matrix), which unit
// tests cover; this catches decode-order, timestamp and payload errors.
// Needs ffmpeg on PATH. Exit code 1 on any mismatch.

import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MkvDemuxer } from '../static/demux/mkvDemuxer.js';
import { createMsePlayer } from '../static/player/msePlayer.js';

const [file, seekArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/verify-remux.mjs <file.mkv> [seekSec]');
  process.exit(2);
}
const seekSec = Number(seekArg) || 0;
const bytes = new Uint8Array(await readFile(file));

// Recording MediaSource: appends complete asynchronously, like a browser.
let done;
const finished = new Promise((r) => { done = r; });
const buffers = [];
globalThis.MediaSource = class {
  constructor() { this.readyState = 'closed'; this.l = {}; this.duration = NaN; setTimeout(() => this.open(), 0); }
  static isTypeSupported() { return true; }
  open() { this.readyState = 'open'; for (const fn of this.l.sourceopen ?? []) fn(); }
  addEventListener(ev, fn) { (this.l[ev] ??= []).push(fn); }
  addSourceBuffer(mime) {
    const b = {
      mime, chunks: [], updating: false, l: {},
      addEventListener(ev, fn) { (this.l[ev] ??= []).push(fn); },
      appendBuffer(d) { this.updating = true; this.chunks.push(d); setTimeout(() => { this.updating = false; for (const fn of this.l.updateend ?? []) fn(); }, 0); },
      remove() { this.updating = true; this.chunks.length = 0; setTimeout(() => { this.updating = false; for (const fn of this.l.updateend ?? []) fn(); }, 0); },
    };
    buffers.push(b);
    return b;
  }
  endOfStream() { this.readyState = 'ended'; done(); }
};
URL.createObjectURL = () => 'blob:verify';
URL.revokeObjectURL = () => {};
const video = {
  currentTime: 0, paused: true, error: null, buffered: { length: 0 },
  addEventListener() {}, removeEventListener() {}, play() {}, pause() {}, removeAttribute() {},
};

const demuxer = new MkvDemuxer(async (s, e) => bytes.slice(s, e + 1), { canPlayAudio: () => true });
const { tracks } = await demuxer.readHeader();
const audio = tracks.find((t) => t.type === 'audio' && t.playable !== false);
const videoTrack = tracks.find((t) => t.type === 'video');
let failure = null;
const player = createMsePlayer(video, demuxer, tracks, { onError: (e) => { failure = e; done(); } });
if (seekSec > 0) {
  await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => { const t = setInterval(() => { if (buffers.length === 2) { clearInterval(t); r(); } }, 1); });
  player.seek(seekSec);
}
await finished;
if (failure) {
  console.error('pipeline error:', failure.message);
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), 'verify-remux-'));
const [vbuf, abuf] = buffers;
const out = { video: join(dir, 'video.mp4'), audio: join(dir, 'audio.mp4') };
// After a seek the remove() cleared everything, so re-prefix the init segment.
const { initSegment } = await import('../static/demux/fmp4Muxer.js');
const withInit = (b, track) => (seekSec > 0 ? [initSegment(track), ...b.chunks] : b.chunks);
await writeFile(out.video, Buffer.concat(withInit(vbuf, videoTrack).map((c) => Buffer.from(c))));
await writeFile(out.audio, Buffer.concat(withInit(abuf, audio).map((c) => Buffer.from(c))));

// framemd5 → [{ms, md5}]: decoded frames (presentation order), or with
// copy the compressed packets themselves.
function frames(input, map, copy = false) {
  const codec = copy ? ['-c', 'copy'] : [];
  // -copyts: keep the stream's own times (no start-time normalization).
  const txt = execFileSync('ffmpeg', ['-v', 'error', '-copyts', '-i', input, '-map', map, ...codec, '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  let tb = 1;
  const rows = [];
  for (const line of txt.split('\n')) {
    const m = /^#tb \d+: (\d+)\/(\d+)/.exec(line);
    if (m) tb = Number(m[1]) / Number(m[2]);
    if (!line || line.startsWith('#')) continue;
    const f = line.split(',').map((x) => x.trim());
    rows.push({ ms: Math.round(Number(f[2]) * tb * 1000), md5: f[5] });
  }
  return rows;
}
// ffmpeg logs decode problems (missing references, bad order) on stderr.
function decodeErrors(input) {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-i', input, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    return '';
  } catch (e) {
    return String(e.stderr || e.message);
  }
}

let ok = true;
// Align on the first output frame (a seek starts mid-file): the reference
// frame with the same content nearest in time — synthetic test signals
// repeat identical frames. Then compare content and relative times (the
// mov demuxer shifts B-frame video by a constant).
function compare(kind, got, want, tolMs) {
  let k = -1;
  for (let i = 0; got.length && i < want.length; i++) {
    if (want[i].md5 !== got[0].md5) continue;
    if (k < 0 || Math.abs(want[i].ms - got[0].ms) < Math.abs(want[k].ms - got[0].ms)) k = i;
  }
  const ref = k >= 0 ? want.slice(k) : [];
  const n = Math.min(got.length, ref.length);
  let bad = 0;
  let first = null;
  for (let i = 0; i < n; i++) {
    const dt = (got[i].ms - got[0].ms) - (ref[i].ms - ref[0].ms);
    if (got[i].md5 !== ref[i].md5 || Math.abs(dt) > tolMs) {
      bad++;
      first ??= `#${i}: got ${got[i].ms}ms ${got[i].md5.slice(0, 8)}, want ${ref[i].ms}ms ${ref[i].md5.slice(0, 8)}`;
    }
  }
  const pass = k >= 0 && bad === 0 && got.length === ref.length;
  ok &&= pass;
  const at = k >= 0 ? ` from ${ref[0].ms}ms` : ' (first frame not found in reference)';
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${kind}: ${got.length} frames (reference ${ref.length}${at}), ${bad} differ${first ? `; first ${first}` : ''}`);
}
for (const [kind, f] of Object.entries(out)) {
  const err = decodeErrors(f);
  if (err) { ok = false; console.log(`FAIL ${kind} decode errors:\n` + err.split('\n').slice(0, 5).join('\n')); }
}
// Video: decoded pictures, in presentation order — catches decode order,
// timestamps and payload.
compare('video', frames(out.video, '0:v'), frames(file, `0:${videoTrack.number - 1}`), 1);
// Audio: compressed packets. Decoded audio can't match bit-for-bit after a
// seek: AAC noise substitution and AC-3 dither draw on a decoder RNG whose
// state depends on everything decoded before. The timeline is continuous
// (frame-exact) while MKV rounds to 1 ms: allow 2 ms.
compare('audio packets', frames(out.audio, '0:a', true), frames(file, `0:${audio.number - 1}`, true), 2);
console.log(`(output in ${dir})`);
process.exit(ok ? 0 : 1);
