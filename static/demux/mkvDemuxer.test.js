import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MkvDemuxer } from './mkvDemuxer.js';

const buf = new Uint8Array(await readFile(new URL('../../testdata/twoaudio.mkv', import.meta.url)));
const fetchRange = async (s, e) => buf.slice(s, e + 1);

test('readHeader lists tracks', async () => {
  const d = new MkvDemuxer(fetchRange);
  const { tracks } = await d.readHeader();
  assert.equal(tracks.filter(t => t.type === 'video').length, 1);
  assert.equal(tracks.filter(t => t.type === 'audio').length, 2);
  assert.equal(tracks.filter(t => t.type === 'subtitle').length, 1);
  assert.equal(tracks.find(t => t.type === 'video').codecId, 'V_MPEG4/ISO/AVC');
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
});

test('samples yields video+audio blocks in order', async () => {
  const d = new MkvDemuxer(fetchRange);
  const { tracks } = await d.readHeader();
  const videoNum = tracks.find(t => t.type === 'video').number;
  const audioNums = tracks.filter(t => t.type === 'audio').map(t => t.number);
  const seen = { video: 0, audio: 0 };
  for await (const s of d.samples(0, 2, [videoNum, ...audioNums])) {
    if (s.trackNumber === videoNum) seen.video++; else seen.audio++;
    assert.ok(s.data.length > 0);
  }
  assert.ok(seen.video >= 15 && seen.audio >= 40); // 2s @10fps, aac frames
});

test('unsupported codec throws', async () => {
  const bad = new Uint8Array(await readFile(new URL('../../testdata/unsupported.mkv', import.meta.url)));
  const d = new MkvDemuxer(async (s, e) => bad.slice(s, e + 1));
  await assert.rejects(() => d.readHeader(), /Unsupported/);
});
