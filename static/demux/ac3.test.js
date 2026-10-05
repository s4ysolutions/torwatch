import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseAc3Frame, dac3Payload, dec3Payload } from './ac3.js';
import { audioSupport } from './codecs.js';
import { MkvDemuxer } from './mkvDemuxer.js';

// ac3mix.mkv: AC-3 5.1 192k, E-AC-3 stereo, AAC mono — all 44100 Hz.
const buf = new Uint8Array(await readFile(new URL('../../testdata/ac3mix.mkv', import.meta.url)));

async function firstFrame(codecId) {
  const d = new MkvDemuxer(async (s, e) => buf.slice(s, e + 1));
  const { tracks } = await d.readHeader();
  const t = tracks.find((x) => x.codecId === codecId);
  for await (const s of d.samples(0, Infinity, [t.number])) return s.data;
  throw new Error('no frame');
}

test('parseAc3Frame reads an AC-3 5.1 header', async () => {
  const info = parseAc3Frame(await firstFrame('A_AC3'));
  assert.equal(info.codec, 'ac-3');
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 6);
  assert.equal(info.acmod, 7);
  assert.equal(info.lfeon, 1);
  assert.equal(info.samplesPerFrame, 1536);
  assert.equal(info.dataRate, 192);
  assert.equal(info.bitRateCode, 10);
});

test('parseAc3Frame reads an E-AC-3 stereo header', async () => {
  const info = parseAc3Frame(await firstFrame('A_EAC3'));
  assert.equal(info.codec, 'ec-3');
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 2);
  assert.equal(info.bsid, 16);
  assert.equal(info.samplesPerFrame, 1536);
  assert.ok(info.dataRate > 100 && info.dataRate < 300);
});

test('parseAc3Frame rejects non-AC-3 bytes', () => {
  assert.equal(parseAc3Frame(new Uint8Array([0xff, 0xf1, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(parseAc3Frame(new Uint8Array([0x0b, 0x77])), null);
  assert.equal(parseAc3Frame(null), null);
});

test('dac3Payload packs the Annex F.4 bit layout', () => {
  // fscod=1 bsid=8 bsmod=0 acmod=7 lfeon=1 bit_rate_code=10 reserved=0
  // 01 01000 000 111 1 01010 00000
  const p = dac3Payload({ fscod: 1, bsid: 8, bsmod: 0, acmod: 7, lfeon: 1, bitRateCode: 10 });
  assert.deepEqual([...p], [0b01010000, 0b00111101, 0b01000000]);
});

test('dec3Payload packs one independent substream (Annex F.6)', () => {
  // data_rate=192 num_ind_sub=0 | fscod=1 bsid=16 r=0 asvc=0 bsmod=0 acmod=2 lfeon=0 r=0 num_dep_sub=0 r=0
  const p = dec3Payload({ dataRate: 192, fscod: 1, bsid: 16, bsmod: 0, acmod: 2, lfeon: 0 });
  assert.deepEqual([...p], [0x06, 0x00, 0b01100000, 0b00000100, 0x00]);
});

test('audioSupport: base codecs always, AC-3/E-AC-3 only when MSE says so', () => {
  const none = audioSupport();
  assert.equal(none({ codecId: 'A_AAC' }), true);
  assert.equal(none({ codecId: 'A_AC3' }), false);
  const seen = [];
  const safari = audioSupport((mime) => { seen.push(mime); return true; });
  assert.equal(safari({ codecId: 'A_AC3' }), true);
  assert.equal(safari({ codecId: 'A_EAC3' }), true);
  assert.equal(safari({ codecId: 'A_DTS' }), false);
  assert.deepEqual(seen, ['audio/mp4; codecs="ac-3"', 'audio/mp4; codecs="ec-3"']);
  const throws = audioSupport(() => { throw new Error('boom'); });
  assert.equal(throws({ codecId: 'A_AC3' }), false);
});
