import test from 'node:test';
import assert from 'node:assert/strict';
import { createFragmenter } from './fragmenter.js';

// Minimal moof parser: tfdt base + trun entries → per-sample dts/pts ticks.
function parseFragment(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const find = (type, from = 0, to = b.length) => {
    for (let off = from; off + 8 <= to;) {
      const size = dv.getUint32(off);
      const t = String.fromCharCode(...b.slice(off + 4, off + 8));
      if (t === type) return off;
      if (['moof', 'traf'].includes(t)) {
        const inner = find(type, off + 8, off + size);
        if (inner >= 0) return inner;
      }
      off += size;
    }
    return -1;
  };
  const tfdt = find('tfdt');
  const base = Number(dv.getBigUint64(tfdt + 12));
  const trun = find('trun');
  const v1 = dv.getUint8(trun + 8) === 1;
  const n = dv.getUint32(trun + 12);
  const out = [];
  let dts = base;
  for (let i = 0; i < n; i++) {
    const e = trun + 20 + i * 16;
    const dur = dv.getUint32(e);
    const cts = v1 ? dv.getInt32(e + 12) : dv.getUint32(e + 12);
    out.push({ dts, pts: dts + cts, dur, size: dv.getUint32(e + 4) });
    dts += dur;
  }
  return out;
}

const video = { number: 1, type: 'video', codecId: 'V_MPEG4/ISO/AVC', codecPrivate: new Uint8Array([1, 100, 0, 30, 255]), width: 640, height: 360 };
const audio = { number: 2, type: 'audio', codecId: 'A_AAC', codecPrivate: new Uint8Array([0x11, 0x90]) }; // 48 kHz

// Decode order of a B-pyramid stream (x264 b-pyramid=normal, 3 B-frames):
// per mini-GOP: P(+4) B(+2) b(+1) b(+3) — PTS in frames.
function pyramidDecodeOrder(frames) {
  const order = [0];
  for (let g = 0; g + 4 < frames; g += 4) order.push(g + 4, g + 2, g + 1, g + 3);
  return order;
}

test('video: B-pyramid stays in decode order with monotonic decode times across fragments', () => {
  const fps = 24000 / 1001;
  const order = pyramidDecodeOrder(400);
  const frags = [];
  const f = createFragmenter(video, (b) => frags.push(b));
  // MKV timestamps are milliseconds
  for (const [i, n] of order.entries()) {
    f.push({ timestamp: Math.round((n / fps) * 1000) / 1000, keyframe: i === 0, data: new Uint8Array([n & 0xff, n >> 8]) });
  }
  f.flush();
  assert.ok(frags.length > 5, 'several fragments');
  const all = frags.flatMap(parseFragment);
  assert.equal(all.length, order.length);
  // payloads in the order pushed (decode order)
  // decode times strictly increase, including across fragment boundaries
  for (let i = 1; i < all.length; i++) assert.ok(all[i].dts > all[i - 1].dts, `dts at ${i}: ${all[i - 1].dts} → ${all[i].dts}`);
  // every presentation time is used exactly once as a decode time
  const ptsSorted = all.map((s) => s.pts).sort((a, b) => a - b);
  assert.deepEqual(all.map((s) => s.dts), ptsSorted);
  // presentation times are the pushed ones
  const want = order.map((n) => Math.round(Math.round((n / fps) * 1000) / 1000 * 90000));
  assert.deepEqual(all.map((s) => s.pts), want);
});

test('audio: continuous timeline across fragments, re-anchored after a gap', () => {
  const frags = [];
  const f = createFragmenter(audio, (b) => frags.push(b));
  const frame = 1024 / 48000;
  // 100 frames, then a 0.5 s gap, then 100 more (ms-rounded like MKV)
  for (let i = 0; i < 200; i++) {
    const t = i * frame + (i >= 100 ? 0.5 : 0);
    f.push({ timestamp: Math.round(t * 1000) / 1000, keyframe: true, data: new Uint8Array(1) });
  }
  f.flush();
  const all = frags.flatMap(parseFragment);
  assert.equal(all.length, 200);
  assert.ok(all.every((s) => s.dur === 1024 && s.pts === s.dts));
  for (let i = 1; i < 100; i++) assert.equal(all[i].dts, all[i - 1].dts + 1024);
  // after the gap: within a frame of the file's time, then continuous again
  assert.ok(Math.abs(all[100].dts - Math.round((100 * frame + 0.5) * 48000)) < 1024);
  for (let i = 101; i < 200; i++) assert.equal(all[i].dts, all[i - 1].dts + 1024);
});
