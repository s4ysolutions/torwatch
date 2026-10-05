import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MkvDemuxer } from './mkvDemuxer.js';

const buf = new Uint8Array(await readFile(new URL('../../testdata/twoaudio.mkv', import.meta.url)));
const fetchRange = async (s, e) => buf.slice(s, e + 1);

test('readHeader lists tracks', async () => {
  const d = new MkvDemuxer(fetchRange);
  const { tracks, timecodeScale } = await d.readHeader();
  assert.equal(tracks.filter(t => t.type === 'video').length, 1);
  assert.equal(tracks.filter(t => t.type === 'audio').length, 2);
  assert.equal(tracks.filter(t => t.type === 'subtitle').length, 1);
  assert.equal(tracks.find(t => t.type === 'video').codecId, 'V_MPEG4/ISO/AVC');
  const audios = tracks.filter(t => t.type === 'audio');
  assert.ok(audios.every(t => t.codecId === 'A_AAC'));
  assert.equal(tracks.find(t => t.type === 'subtitle').codecId, 'S_TEXT/UTF8');
  assert.ok(tracks.find(t => t.type === 'video').codecPrivate.length > 0);
  assert.ok(tracks.every(t => typeof t.language === 'string' && t.language.length > 0));
  assert.equal(timecodeScale, 1_000_000);
  assert.ok(d.durationSec() > 1.5 && d.durationSec() < 3);
});

test('subtitleCues extracts text', async () => {
  const d = new MkvDemuxer(fetchRange);
  const { tracks } = await d.readHeader();
  const sub = tracks.find(t => t.type === 'subtitle');
  const cues = await d.subtitleCues(sub.number);
  assert.ok(cues.length >= 1);
  assert.match(cues[0].text, /Hello fixture/);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 1.5); // BlockDuration (srt: 0 → 1.5s)
});

test('samples yields video+audio blocks in order', async () => {
  const d = new MkvDemuxer(fetchRange);
  const { tracks } = await d.readHeader();
  const videoNum = tracks.find(t => t.type === 'video').number;
  const audioNums = tracks.filter(t => t.type === 'audio').map(t => t.number);
  const subNum = tracks.find(t => t.type === 'subtitle').number;
  const seen = { video: 0, audio: 0 };
  for await (const s of d.samples(0, 2, [videoNum, ...audioNums])) {
    if (s.trackNumber === videoNum) seen.video++; else seen.audio++;
    assert.ok(s.data.length > 0);
    assert.ok(s.timestamp >= 0 && s.timestamp <= 2);
    assert.notEqual(s.trackNumber, subNum);
  }
  assert.ok(seen.video >= 15 && seen.audio >= 40); // 2s @10fps, aac frames
});

test('unsupported codec throws', async () => {
  const bad = new Uint8Array(await readFile(new URL('../../testdata/unsupported.mkv', import.meta.url)));
  const d = new MkvDemuxer(async (s, e) => bad.slice(s, e + 1));
  await assert.rejects(() => d.readHeader(), /Unsupported/);
});

// --- synthetic lacing ---

function lacedDemuxer(payload) {
  const d = new MkvDemuxer(async () => new Uint8Array(0));
  d.stream = { buf: payload, winStart: 0 };
  return d;
}

test('splitFrames Xiph lacing', () => {
  // 2 frames: sizes [3, rest=2]. count=1, size byte 0x03.
  const d = lacedDemuxer(new Uint8Array([0x01, 0x03, 10, 20, 30, 40, 50]));
  const out = d.splitFrames(1, 0, 7);
  assert.equal(out.length, 2);
  assert.deepEqual([...out[0]], [10, 20, 30]);
  assert.deepEqual([...out[1]], [40, 50]);
});

test('splitFrames fixed-size lacing', () => {
  // 2 frames of 3 bytes each. count=1.
  const d = lacedDemuxer(new Uint8Array([0x01, 1, 2, 3, 4, 5, 6]));
  const out = d.splitFrames(2, 0, 7);
  assert.equal(out.length, 2);
  assert.deepEqual([...out[0]], [1, 2, 3]);
  assert.deepEqual([...out[1]], [4, 5, 6]);
});

test('splitFrames EBML lacing', () => {
  // 3 frames sizes [2, 4, rest=3]. count=2. first 0x82. diff 4-2=+2,
  // len 1, bias 63 → 65 = 0xC1.
  const d = lacedDemuxer(new Uint8Array([0x02, 0x82, 0xC1, 10, 20, 30, 40, 50, 60, 70, 80, 90]));
  const out = d.splitFrames(3, 0, 12);
  assert.equal(out.length, 3);
  assert.deepEqual([...out[0]], [10, 20]);
  assert.deepEqual([...out[1]], [30, 40, 50, 60]);
  assert.deepEqual([...out[2]], [70, 80, 90]);
});

test('splitFrames EBML lacing negative diff', () => {
  // 3 frames sizes [4, 2, rest=3]. diff 2-4=-2, bias 63 → 61 = 0xBD.
  const d = lacedDemuxer(new Uint8Array([0x02, 0x84, 0xBD, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const out = d.splitFrames(3, 0, 12);
  assert.equal(out.length, 3);
  assert.deepEqual([...out[0]], [1, 2, 3, 4]);
  assert.deepEqual([...out[1]], [5, 6]);
  assert.deepEqual([...out[2]], [7, 8, 9]);
});

// --- per-track audio playability (ac3mix.mkv: AC-3, E-AC-3, AAC) ---

const mix = new Uint8Array(await readFile(new URL('../../testdata/ac3mix.mkv', import.meta.url)));
const mixRange = async (s, e) => mix.slice(s, e + 1);
const audioOf = (tracks) => tracks.filter((t) => t.type === 'audio');

test('unplayable audio tracks are flagged, not fatal, when one track plays', async () => {
  const d = new MkvDemuxer(mixRange); // default: no AC-3 decoder
  const { tracks } = await d.readHeader();
  assert.deepEqual(audioOf(tracks).map((t) => [t.codecId, t.playable]), [
    ['A_AC3', false],
    ['A_EAC3', false],
    ['A_AAC', true],
  ]);
});

test('no playable audio track throws Unsupported listing the codecs', async () => {
  const d = new MkvDemuxer(mixRange, { canPlayAudio: () => false });
  await assert.rejects(() => d.readHeader(), /Unsupported audio codec: A_AC3, A_EAC3, A_AAC/);
});

test('passthrough AC-3/E-AC-3 get first-frame config when the browser decodes them', async () => {
  const d = new MkvDemuxer(mixRange, { canPlayAudio: () => true });
  const { tracks } = await d.readHeader();
  const [ac3, eac3, aac] = audioOf(tracks);
  assert.equal(ac3.playable, true);
  assert.equal(ac3.ac3.codec, 'ac-3');
  assert.equal(ac3.ac3.channels, 6);
  assert.equal(eac3.playable, true);
  assert.equal(eac3.ac3.codec, 'ec-3');
  assert.equal(aac.playable, true);
  assert.equal(aac.ac3, undefined);
});

test('passthrough track whose first frame is out of probe range is unplayable', async () => {
  // maxBytes 1 → probe budget 0: no frame read, AC-3 tracks drop out, AAC stays.
  const d = new MkvDemuxer(mixRange, { canPlayAudio: () => true, maxBytes: 1 });
  const { tracks } = await d.readHeader();
  assert.deepEqual(audioOf(tracks).map((t) => t.playable), [false, false, true]);
});

// --- seeking (seek.mkv: 20s, 2s clusters, keyframe every 2s, Cues) ---

const seekBuf = new Uint8Array(await readFile(new URL('../../testdata/seek.mkv', import.meta.url)));

function counting(bytes) {
  const stats = { bytes: 0 };
  const fr = async (s, e) => {
    const out = bytes.slice(s, e + 1);
    stats.bytes += out.length;
    return out;
  };
  return { fr, stats };
}

// Rename the Cues element (ID 1C53BB6B → unknown) so the file has no index.
function withoutCues(bytes) {
  const b = bytes.slice();
  for (let i = b.length - 4; i >= 0; i--) {
    if (b[i] === 0x1c && b[i + 1] === 0x53 && b[i + 2] === 0xbb && b[i + 3] === 0x6b) {
      b[i + 3] = 0x6c;
      return b;
    }
  }
  throw new Error('no Cues in fixture');
}

async function firstVideoAfterSeek(bytes, sec) {
  const { fr, stats } = counting(bytes);
  const d = new MkvDemuxer(fr, { chunkSize: 16 * 1024 });
  const { tracks } = await d.readHeader();
  const v = tracks.find((t) => t.type === 'video').number;
  stats.bytes = 0; // count the seek only
  // MSE drops leading non-key frames, so what matters is the first keyframe.
  for await (const s of d.samples(sec, Infinity, [v])) if (s.keyframe) return { s, stats, cues: d.cues };
  throw new Error('no samples');
}

test('seek with Cues starts at the keyframe cluster, not the file start', async () => {
  const { s, stats, cues } = await firstVideoAfterSeek(seekBuf, 15);
  assert.ok(cues.length >= 5, `cues parsed: ${cues.length}`);
  assert.equal(s.keyframe, true);
  assert.ok(s.timestamp <= 15 && s.timestamp > 12, `starts at ${s.timestamp}`);
  assert.ok(stats.bytes < seekBuf.length / 3, `fetched ${stats.bytes} of ${seekBuf.length}`);
});

test('seek without Cues hops cluster headers instead of reading payloads', async () => {
  const { s, stats, cues } = await firstVideoAfterSeek(withoutCues(seekBuf), 15);
  assert.equal(cues.length, 0);
  assert.equal(s.keyframe, true);
  assert.ok(s.timestamp <= 15 && s.timestamp > 12, `starts at ${s.timestamp}`);
  assert.ok(stats.bytes < seekBuf.length / 3, `fetched ${stats.bytes} of ${seekBuf.length}`);
});

test('concurrent walks do not corrupt each other (own window each)', async () => {
  const d = new MkvDemuxer(async (s, e) => {
    await new Promise((r) => setTimeout(r, Math.random() * 3)); // interleave fetches
    return seekBuf.slice(s, e + 1);
  }, { chunkSize: 8 * 1024 });
  const { tracks } = await d.readHeader();
  const nums = tracks.map((t) => t.number);
  const collect = async (from) => {
    const out = [];
    for await (const s of d.samples(from, Infinity, nums)) out.push(`${s.trackNumber}@${s.timestamp}:${s.data.length}`);
    return out;
  };
  const solo = await collect(10);
  const [a, b] = await Promise.all([collect(0), collect(10)]);
  assert.deepEqual(b, solo);
  assert.ok(a.length > b.length);
});
