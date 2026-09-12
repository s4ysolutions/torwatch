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
  assert.equal(cues[0].end, 2); // single cue: +2s fallback
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
