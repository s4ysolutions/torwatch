import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ByteStream } from './byteStream.js';
import { MkvDemuxer } from './mkvDemuxer.js';

const src = new Uint8Array(100 * 1024).map((_, i) => i & 0xff);
const rangeOf = (log) => async (s, e) => {
  log?.push([s, e]);
  return src.slice(s, Math.min(e + 1, src.length));
};

function tracksKey(tracks) {
  return tracks.map((t) => ({
    number: t.number,
    type: t.type,
    codecId: t.codecId,
    language: t.language,
    name: t.name,
    codecPrivate: [...t.codecPrivate],
  }));
}

test('window stays bounded on sequential reads', async () => {
  const bs = new ByteStream(rangeOf(), 1024, 4 * 1024);
  for (let off = 0; off < src.length; off += 997) {
    const len = Math.min(997, src.length - off);
    const got = await bs.read(off, len);
    assert.deepEqual([...got], [...src.slice(off, off + len)]);
    assert.ok(bs.length <= 4 * 1024, `retained ${bs.length} > cap at off ${off}`);
  }
});

test('backward re-read resets window and returns correct data', async () => {
  const bs = new ByteStream(rangeOf(), 1024, 4 * 1024);
  const tail = await bs.read(90 * 1024, 1000);
  assert.deepEqual([...tail], [...src.slice(90 * 1024, 90 * 1024 + 1000)]);
  const head = await bs.read(0, 2000); // off < winStart → re-fetch
  assert.deepEqual([...head], [...src.slice(0, 2000)]);
  assert.ok(bs.length <= 4 * 1024 + 2000, `retained ${bs.length} unbounded`);
  // forward again after the backward jump
  const mid = await bs.read(50 * 1024, 500);
  assert.deepEqual([...mid], [...src.slice(50 * 1024, 50 * 1024 + 500)]);
});

test('read() returns fresh copies (no stale-buffer aliasing)', async () => {
  const bs = new ByteStream(rangeOf(), 1024, 4 * 1024);
  const a = await bs.read(0, 100);
  a.fill(0xff); // mutate the copy
  const b = await bs.read(0, 100);
  assert.deepEqual([...b], [...src.slice(0, 100)]);
});

test('tiny-cap demuxer readHeader matches full-window tracks', async () => {
  const buf = new Uint8Array(await readFile(new URL('../../testdata/twoaudio.mkv', import.meta.url)));
  const fetchRange = async (s, e) => buf.slice(s, e + 1);
  const full = new MkvDemuxer(fetchRange);
  const tiny = new MkvDemuxer(fetchRange, { chunkSize: 1024, maxBytes: 4 * 1024 });
  const a = await full.readHeader();
  const b = await tiny.readHeader();
  assert.deepEqual(tracksKey(b.tracks), tracksKey(a.tracks));
  assert.equal(b.timecodeScale, a.timecodeScale);
});
