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

test('codecString for synthetic HEVC track (big-endian compat, full constraints)', () => {
  // hvcC: version(1) | profile_space/tier/idc | compat[4] | constraints[6] | level | ...
  const hvcC = new Uint8Array([
    0x01, 0x01, // version, profile_space=0 tier=L profile_idc=1
    0x12, 0x34, 0x56, 0x78, // general_profile_compatibility_flags (big-endian)
    0xb0, 0x00, 0x00, 0x00, 0x00, 0x00, // general_constraint_indicator_flags (6 bytes)
    120, // general_level_idc
    0xf0, 0x00, 0xfc, 0xfd, 0x00, 0x00, 0x03, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x7b,
  ]);
  const track = { type: 'video', codecId: 'V_MPEGH/ISO/HEVC', codecPrivate: hvcC, language: 'und' };
  assert.equal(codecString(track), 'hev1.1.12345678.L120.b00000000000');
});

test('codecString for synthetic HEVC track pads small compat to 8 hex digits', () => {
  const hvcC = new Uint8Array([
    0x01, 0x01,
    0x00, 0x00, 0x00, 0x01, // compat = 1 → must render '00000001', not '1'
    0xb0, 0x00, 0x00, 0x00, 0x00, 0x00,
    120,
    0xf0, 0x00, 0xfc, 0xfd, 0x00, 0x00, 0x03, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x7b,
  ]);
  const track = { type: 'video', codecId: 'V_MPEGH/ISO/HEVC', codecPrivate: hvcC, language: 'und' };
  assert.equal(codecString(track), 'hev1.1.00000001.L120.b00000000000');
});

test('MP3 track: codecString and 44100 mdhd timescale', () => {
  const track = { type: 'audio', codecId: 'A_MPEG/L3', codecPrivate: new Uint8Array(0), language: 'und' };
  assert.equal(codecString(track), 'mp4a.69');
  const init = initSegment(track);
  assert.ok(containsBox(init, 'mp4a'));
  const mdhd = findBox(init, 'mdhd');
  assert.ok(mdhd);
  // mdhd v0: size(4) type(4) v/f(4) ctime(4) mtime(4) timescale(4)
  assert.equal(new DataView(mdhd.buffer, mdhd.byteOffset, mdhd.length).getUint32(20), 44100);
});

// --- AC-3 / E-AC-3 passthrough ---

const ac3Info = { codec: 'ac-3', sampleRate: 48000, channels: 6, samplesPerFrame: 1536, fscod: 0, bsid: 8, bsmod: 0, acmod: 7, lfeon: 1, bitRateCode: 15, dataRate: 448 };
const eac3Info = { codec: 'ec-3', sampleRate: 48000, channels: 2, samplesPerFrame: 1536, fscod: 0, bsid: 16, bsmod: 0, acmod: 2, lfeon: 0, dataRate: 224 };

test('AC-3 track: ac-3 sample entry with dac3, sample-rate timescale', () => {
  const track = { type: 'audio', codecId: 'A_AC3', codecPrivate: new Uint8Array(0), language: 'rus', ac3: ac3Info };
  assert.equal(codecString(track), 'ac-3');
  const init = initSegment(track);
  assert.ok(containsBox(init, 'ac-3'));
  const dac3 = findBox(init, 'dac3');
  assert.ok(dac3);
  assert.equal(dac3.length, 11);
  const mdhd = findBox(init, 'mdhd');
  assert.equal(new DataView(mdhd.buffer, mdhd.byteOffset, mdhd.length).getUint32(20), 48000);
});

test('E-AC-3 track: ec-3 sample entry with dec3', () => {
  const track = { type: 'audio', codecId: 'A_EAC3', codecPrivate: new Uint8Array(0), language: 'eng', ac3: eac3Info };
  assert.equal(codecString(track), 'ec-3');
  const init = initSegment(track);
  assert.ok(containsBox(init, 'ec-3'));
  const dec3 = findBox(init, 'dec3');
  assert.ok(dec3);
  assert.equal(dec3.length, 13);
});

test('AC-3 fragment uses 1536-sample durations', () => {
  const track = { type: 'audio', codecId: 'A_AC3', codecPrivate: new Uint8Array(0), language: 'und', ac3: ac3Info };
  // MKV 1ms timestamps: 32ms steps, not exactly 1536/48000
  const samples = [0, 0.032, 0.064].map((timestamp) => ({ timestamp, keyframe: true, data: new Uint8Array(4) }));
  const frag = fragment(track, samples, 0);
  const trun = findBox(frag, 'trun');
  const dv = new DataView(trun.buffer, trun.byteOffset, trun.length);
  // trun: size type v/f count data_offset, then per sample: duration size flags cts
  assert.equal(dv.getUint32(12), 3);
  for (let i = 0; i < 3; i++) assert.equal(dv.getUint32(20 + i * 16), 1536);
});

test('AC-3 track without first-frame config fails loudly', () => {
  const track = { type: 'audio', codecId: 'A_AC3', codecPrivate: new Uint8Array(0), language: 'und' };
  assert.throws(() => initSegment(track), /first-frame config/);
});

test('fragment rounds a fractional baseDecodeTime instead of throwing', () => {
  const track = { type: 'video', codecId: 'V_MPEG4/ISO/AVC', codecPrivate: new Uint8Array([1, 100, 0, 12, 255]), language: 'und' };
  const frag = fragment(track, [{ timestamp: 0.009, keyframe: true, data: new Uint8Array(4) }], 0.009 * 90000);
  const tfdt = findBox(frag, 'tfdt');
  assert.equal(Number(new DataView(tfdt.buffer, tfdt.byteOffset, tfdt.length).getBigUint64(12)), 810);
});
