import { test } from 'node:test';
import assert from 'node:assert/strict';

test('player modules import in node without exploding', async () => {
  const native = await import('./nativePlayer.js');
  assert.equal(typeof native.createNativePlayer, 'function');
  const mse = await import('./msePlayer.js');
  assert.equal(typeof mse.createMsePlayer, 'function');
});

// seek() before sourceopen must not throw (buffers not attached yet) —
// it just moves currentTime and the sourceopen pump covers the seek.
test('mse seek-before-sourceopen does not deref null buffers', async () => {
  const listeners = {};
  const appended = [];
  const mkBuf = () => ({
    updating: false,
    appendBuffer(d) { appended.push(d); },
    addEventListener(ev, fn) { (listeners[ev] ??= []).push(fn); },
    remove() {},
    abort() {},
  });
  globalThis.MediaSource = class {
    constructor() {
      this.readyState = 'open';
      this._listeners = {};
      globalThis.__lastMS = this;
    }
    addEventListener(ev, fn) { (this._listeners[ev] ??= []).push(fn); }
    fire(ev) { for (const fn of this._listeners[ev] ?? []) fn(); }
    addSourceBuffer() { return mkBuf(); }
    removeSourceBuffer() {}
    endOfStream() {}
  };
  const origCreate = globalThis.URL.createObjectURL;
  const origRevoke = globalThis.URL.revokeObjectURL;
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => {};
  try {
    const { createMsePlayer } = await import('./msePlayer.js');
    const videoEl = {
      src: null,
      currentTime: 0,
      buffered: { length: 0 },
      play() {},
      pause() {},
      removeAttribute() {},
    };
    const demuxer = {
      durationSec: () => 10,
      async *samples() {},
    };
    const tracks = [
      { number: 1, type: 'video', codecId: 'V_MPEG4/ISO/AVC', codecPrivate: new Uint8Array([1, 100, 0, 12, 255]), language: 'und' },
      { number: 2, type: 'audio', codecId: 'A_AAC', codecPrivate: new Uint8Array([0x12, 0x10]), language: 'und' },
    ];
    const player = createMsePlayer(videoEl, demuxer, tracks);
    assert.doesNotThrow(() => player.seek(5)); // no {buf:null} queue push
    assert.equal(videoEl.currentTime, 5);
    // sourceopen still attaches + pumps from the sought position
    globalThis.__lastMS.fire('sourceopen');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(appended.length >= 2); // video+audio init segments
    player.dispose();
  } finally {
    globalThis.URL.createObjectURL = origCreate;
    globalThis.URL.revokeObjectURL = origRevoke;
    delete globalThis.MediaSource;
    delete globalThis.__lastMS;
  }
});

test('mse player skips unplayable audio tracks (attach + setAudioTrack)', async () => {
  const mimes = [];
  const mkBuf = () => ({ updating: false, appendBuffer() {}, addEventListener() {}, remove() {}, abort() {} });
  globalThis.MediaSource = class {
    constructor() { this._l = {}; globalThis.__lastMS = this; }
    addEventListener(ev, fn) { (this._l[ev] ??= []).push(fn); }
    fire(ev) { for (const fn of this._l[ev] ?? []) fn(); }
    addSourceBuffer(mime) { mimes.push(mime); return mkBuf(); }
    removeSourceBuffer() {}
    endOfStream() {}
  };
  const origCreate = globalThis.URL.createObjectURL;
  const origRevoke = globalThis.URL.revokeObjectURL;
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => {};
  try {
    const { createMsePlayer } = await import('./msePlayer.js');
    const videoEl = { src: null, currentTime: 0, buffered: { length: 0 }, play() {}, pause() {}, removeAttribute() {} };
    const demuxer = { durationSec: () => 10, async *samples() {} };
    const tracks = [
      { number: 1, type: 'video', codecId: 'V_MPEG4/ISO/AVC', codecPrivate: new Uint8Array([1, 100, 0, 12, 255]), language: 'und' },
      { number: 2, type: 'audio', codecId: 'A_AC3', codecPrivate: new Uint8Array(0), language: 'rus', playable: false },
      { number: 3, type: 'audio', codecId: 'A_AAC', codecPrivate: new Uint8Array([0x12, 0x10]), language: 'eng', playable: true },
    ];
    const player = createMsePlayer(videoEl, demuxer, tracks);
    globalThis.__lastMS.fire('sourceopen');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(mimes, ['video/mp4; codecs="avc1.64000c"', 'audio/mp4; codecs="mp4a.40.2"']);
    player.setAudioTrack(2); // unplayable: ignored, no new SourceBuffer
    assert.equal(mimes.length, 2);
    player.dispose();
  } finally {
    globalThis.URL.createObjectURL = origCreate;
    globalThis.URL.revokeObjectURL = origRevoke;
    delete globalThis.MediaSource;
    delete globalThis.__lastMS;
  }
});

test('mse fragments carry tfdt in each track timescale (90k video, sample-rate audio)', async () => {
  const appended = new Map(); // mime -> [Uint8Array]
  const mkBuf = (mime) => ({
    updating: false,
    appendBuffer(d) { (appended.get(mime) ?? appended.set(mime, []).get(mime)).push(d); },
    addEventListener() {},
    remove() {},
    abort() {},
  });
  globalThis.MediaSource = class {
    constructor() { this._l = {}; this.readyState = 'open'; globalThis.__lastMS = this; }
    addEventListener(ev, fn) { (this._l[ev] ??= []).push(fn); }
    fire(ev) { for (const fn of this._l[ev] ?? []) fn(); }
    addSourceBuffer(mime) { return mkBuf(mime); }
    removeSourceBuffer() {}
    endOfStream() {}
  };
  const origCreate = globalThis.URL.createObjectURL;
  const origRevoke = globalThis.URL.revokeObjectURL;
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => {};
  const tfdtOf = (b) => {
    for (let i = 0; i + 16 <= b.length; i++) {
      if (b[i] === 0x74 && b[i + 1] === 0x66 && b[i + 2] === 0x64 && b[i + 3] === 0x74) {
        return Number(new DataView(b.buffer, b.byteOffset).getBigUint64(i + 8));
      }
    }
    return null;
  };
  try {
    const { createMsePlayer } = await import('./msePlayer.js');
    const videoEl = { src: null, currentTime: 0, buffered: { length: 0 }, play() {}, pause() {}, removeAttribute() {} };
    // 1.009s: ms timestamp whose ×90000 / ×44100 products are not integers.
    const demuxer = {
      durationSec: () => 10,
      async *samples() {
        yield { trackNumber: 1, timestamp: 1.009, keyframe: true, data: new Uint8Array(8) };
        yield { trackNumber: 2, timestamp: 1.009, keyframe: true, data: new Uint8Array(8) };
      },
    };
    const tracks = [
      { number: 1, type: 'video', codecId: 'V_MPEG4/ISO/AVC', codecPrivate: new Uint8Array([1, 100, 0, 12, 255]), language: 'und' },
      // AAC-LC 44100 Hz
      { number: 2, type: 'audio', codecId: 'A_AAC', codecPrivate: new Uint8Array([0x12, 0x10]), language: 'und' },
    ];
    let err = null;
    const player = createMsePlayer(videoEl, demuxer, tracks, { onError: (e) => { err = e; } });
    globalThis.__lastMS.fire('sourceopen');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(err, null);
    const frag = (mime) => appended.get(mime).find((b) => tfdtOf(b) !== null);
    assert.equal(tfdtOf(frag('video/mp4; codecs="avc1.64000c"')), Math.round(1.009 * 90000));
    assert.equal(tfdtOf(frag('audio/mp4; codecs="mp4a.40.2"')), Math.round(1.009 * 44100));
    player.dispose();
  } finally {
    globalThis.URL.createObjectURL = origCreate;
    globalThis.URL.revokeObjectURL = origRevoke;
    delete globalThis.MediaSource;
    delete globalThis.__lastMS;
  }
});

// --- MSE helpers ---

test('drainGroups flushes leftover partial groups and empties them', async () => {
  const { drainGroups } = await import('./mseHelpers.js');
  const groups = new Map([
    ['0:12', [{ timestamp: 12.1 }, { timestamp: 12.4 }]],
    ['1:12', []],
    ['0:13', [{ timestamp: 13.0 }]],
  ]);
  const emitted = [];
  const n = drainGroups(groups, (key, batch) => emitted.push([key, batch.length]));
  assert.equal(n, 2);
  assert.deepEqual(emitted, [['0:12', 2], ['0:13', 1]]);
  for (const [, samples] of groups) assert.equal(samples.length, 0);
  assert.equal(drainGroups(groups, () => { throw new Error('must not emit'); }), 0);
  assert.equal(drainGroups(null, () => {}), 0);
});

test('finalizePlayback ends stream only when open, never throws', async () => {
  const { finalizePlayback } = await import('./mseHelpers.js');
  let calls = 0;
  assert.ok(finalizePlayback({ readyState: 'open', endOfStream: () => { calls++; } }));
  assert.equal(calls, 1);
  assert.equal(finalizePlayback({ readyState: 'closed', endOfStream: () => { calls++; } }), false);
  assert.equal(calls, 1);
  assert.equal(finalizePlayback(null), false);
  assert.equal(finalizePlayback({
    readyState: 'open',
    endOfStream: () => { throw new Error('InvalidStateError'); },
  }), false);
});
