import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MkvDemuxer } from './mkvDemuxer.js';
import { box, initSegment, fragment, codecString } from './fmp4Muxer.js';

const buf = new Uint8Array(await readFile(new URL('../../testdata/twoaudio.mkv', import.meta.url)));
const rangeOf = () => async (s, e) => buf.slice(s, e + 1);

// ---- box helpers (live in the test file per brief) ----
function ascii(b, off, len) {
  return String.fromCharCode(...b.slice(off, off + len));
}

function topBoxes(b) {
  const out = [];
  let off = 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  while (off + 8 <= b.length) {
    const size = dv.getUint32(off);
    if (size < 8 || off + size > b.length) break;
    out.push({ type: ascii(b, off + 4, 4), off, size });
    off += size;
  }
  return out;
}

function containsBox(b, fourcc) {
  const FULL = new Set(['mvhd', 'tkhd', 'mdhd', 'hdlr', 'vmhd', 'smhd', 'dref', 'url ',
    'stsd', 'stts', 'stsc', 'stsz', 'stco', 'esds', 'mfhd', 'tfhd', 'tfdt', 'trun']);
  if (b.length < 8) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  let structured = true;
  for (let off = 0; off + 8 <= b.length;) {
    const size = dv.getUint32(off);
    if (size < 8 || off + size > b.length) { structured = false; break; }
    const type = ascii(b, off + 4, 4);
    if (type === fourcc) return true;
    // recurse into payload
    let payload = b.slice(off + 8, off + size);
    if (FULL.has(type)) payload = payload.slice(8); // skip version/flags
    if (containsBox(payload, fourcc)) return true;
    off += size;
  }
  if (structured) return false;
  // raw byte scan fallback (e.g. avcC nested deep)
  const tag = [...fourcc].map(c => c.charCodeAt(0));
  outer: for (let i = 0; i + 4 <= b.length; i++) {
    for (let j = 0; j < 4; j++) if (b[i + j] !== tag[j]) continue outer;
    return true;
  }
  return false;
}

function findBox(b, fourcc) {
  const FULL = new Set(['mvhd', 'tkhd', 'mdhd', 'hdlr', 'vmhd', 'smhd', 'dref', 'url ',
    'stsd', 'stts', 'stsc', 'stsz', 'stco', 'esds', 'mfhd', 'tfhd', 'tfdt', 'trun']);
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  for (let off = 0; off + 8 <= b.length;) {
    const size = dv.getUint32(off);
    if (size < 8 || off + size > b.length) break; // e.g. sample entries: fall to raw scan
    const type = ascii(b, off + 4, 4);
    if (type === fourcc) return b.slice(off, off + size);
    let payload = b.slice(off + 8, off + size);
    if (FULL.has(type)) payload = payload.slice(8); // skip version/flags
    const inner = findBox(payload, fourcc);
    if (inner) return inner;
    off += size;
  }
  // raw scan fallback (sample entries like avc1 have reserved bytes before kids)
  const tag = [...fourcc].map(c => c.charCodeAt(0));
  for (let i = 0; i + 4 <= b.length; i++) {
    if (b[i] === tag[0] && b[i + 1] === tag[1] && b[i + 2] === tag[2] && b[i + 3] === tag[3]) {
      if (i < 4) continue;
      const size = dv.getUint32(i - 4);
      if (size >= 8 && i - 4 + size <= b.length) return b.slice(i - 4, i - 4 + size);
    }
  }
  return null;
}

test('box() writes size+type+payload', () => {
  const b = box('ftyp', new Uint8Array([1, 2, 3]));
  assert.equal(b.length, 11);
  assert.equal(new DataView(b.buffer).getUint32(0), 11);
  assert.equal(ascii(b, 4, 4), 'ftyp');
  assert.deepEqual([...b.slice(8)], [1, 2, 3]);
});

test('init segment has ftyp+moov with avcC', async () => {
  const d = new MkvDemuxer(rangeOf());
  const { tracks } = await d.readHeader();
  const v = tracks.find(t => t.type === 'video');
  const init = initSegment(v);
  assert.equal(ascii(init, 4, 4), 'ftyp');
  assert.ok(containsBox(init, 'moov'));
  assert.ok(containsBox(init, 'trex')); // MSE requires mvex/trex
  const avcC = findBox(init, 'avcC');
  assert.ok(avcC);
  assert.deepEqual([...avcC.slice(8)], [...v.codecPrivate]);
});

test('init segment for audio has mp4a+esds', async () => {
  const d = new MkvDemuxer(rangeOf());
  const { tracks } = await d.readHeader();
  const a = tracks.find(t => t.type === 'audio');
  const init = initSegment(a);
  assert.equal(ascii(init, 4, 4), 'ftyp');
  assert.ok(containsBox(init, 'moov'));
  assert.ok(containsBox(init, 'mp4a'));
  assert.ok(containsBox(init, 'esds'));
});

test('fixture h264 samples are AVCC length-prefixed (no Annex-B)', async () => {
  const d = new MkvDemuxer(rangeOf());
  const { tracks } = await d.readHeader();
  const vnum = tracks.find(t => t.type === 'video').number;
  let n = 0;
  for await (const s of d.samples(0, 0.5, [vnum])) {
    const dv = new DataView(s.data.buffer, s.data.byteOffset, s.data.length);
    const nalLen = dv.getUint32(0);
    // length prefix must point inside the sample; Annex-B would start 0x00000001
    assert.ok(nalLen > 0 && nalLen + 4 <= s.data.length, `sample ${n} not AVCC`);
    n++;
  }
  assert.ok(n > 0);
});

test('fragment round-trips sample count and timestamps', async () => {
  const d = new MkvDemuxer(rangeOf());
  const { tracks } = await d.readHeader();
  const v = tracks.find(t => t.type === 'video');
  const samples = [];
  for await (const s of d.samples(0, 0.5, [v.number])) samples.push(s);
  assert.ok(samples.length > 0);
  const baseDecodeTime = 0;
  const frag = fragment(v, samples, baseDecodeTime);
  const boxes = topBoxes(frag);
  assert.deepEqual(boxes.map(x => x.type), ['moof', 'mdat']);
  const tfdt = findBox(frag, 'tfdt');
  assert.ok(tfdt);
  const tfdtV = new DataView(tfdt.buffer, tfdt.byteOffset, tfdt.length);
  assert.equal(tfdtV.getUint8(8), 1); // version 1 → 64-bit
  assert.equal(Number(tfdtV.getBigUint64(12)), baseDecodeTime);
  const trun = findBox(frag, 'trun');
  assert.ok(trun);
  const trunV = new DataView(trun.buffer, trun.byteOffset, trun.length);
  const flags = (trunV.getUint8(9) << 16) | (trunV.getUint8(10) << 8) | trunV.getUint8(11);
  assert.ok(flags & 0x1); // data-offset present
  assert.ok(flags & 0x100); // sample-duration present
  assert.ok(flags & 0x200); // sample-size present
  assert.ok(flags & 0x400); // sample-flags present
  assert.ok(flags & 0x800); // sample-cts present
  assert.equal(trunV.getUint32(12), samples.length);
  // mdat payload == concatenated sample bytes
  const mdat = boxes.find(x => x.type === 'mdat');
  let total = 0;
  for (const s of samples) total += s.data.length;
  assert.equal(mdat.size, 8 + total);
  // durations positive, sizes match
  let off = 20; // version/flags + sample_count + data_offset
  const durs = [];
  for (let i = 0; i < samples.length; i++) {
    const dur = trunV.getUint32(off); off += 4;
    const size = trunV.getUint32(off); off += 4;
    off += 4; // flags
    off += 4; // cts
    assert.ok(dur > 0, `sample ${i} duration ${dur}`);
    assert.equal(size, samples[i].data.length);
    durs.push(dur);
  }
  // CBR fixture: uniform durations (B-frame PTS jumps must not stretch timeline)
  assert.ok(durs.every(d => d === durs[0]));
});

test('fragment carries nonzero baseDecodeTime', async () => {
  const d = new MkvDemuxer(rangeOf());
  const { tracks } = await d.readHeader();
  const a = tracks.find(t => t.type === 'audio');
  const samples = [];
  for await (const s of d.samples(0, 0.2, [a.number])) samples.push(s);
  assert.ok(samples.length > 0);
  const frag = fragment(a, samples, 9000);
  const tfdt = findBox(frag, 'tfdt');
  const tfdtV = new DataView(tfdt.buffer, tfdt.byteOffset, tfdt.length);
  assert.equal(Number(tfdtV.getBigUint64(12)), 9000);
  const trun = findBox(frag, 'trun');
  assert.equal(new DataView(trun.buffer, trun.byteOffset, trun.length).getUint32(12), samples.length);
  // AAC frames are always 1024 samples
  const trunV = new DataView(trun.buffer, trun.byteOffset, trun.length);
  for (let i = 0; i < samples.length; i++) {
    assert.equal(trunV.getUint32(20 + i * 16), 1024);
  }
});

test('codecString for fixture tracks', async () => {
  const d = new MkvDemuxer(rangeOf());
  const { tracks } = await d.readHeader();
  const v = tracks.find(t => t.type === 'video');
  assert.ok(codecString(v).startsWith('avc1.'));
  assert.equal(codecString(v), 'avc1.64000c');
  for (const a of tracks.filter(t => t.type === 'audio')) {
    assert.equal(codecString(a), 'mp4a.40.2');
  }
});
