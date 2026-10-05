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

// --- strict MSE fake: throws InvalidStateError where the MSE spec does ---

function invalidState(msg) {
  return Object.assign(new Error(`The object is in an invalid state. (${msg})`), { name: 'InvalidStateError' });
}

function installStrictMse() {
  const all = [];
  class StrictSourceBuffer {
    constructor(ms, mime) {
      this.ms = ms; this.mime = mime; this.updating = false; this.op = null; this.l = {}; this.appended = [];
    }
    addEventListener(ev, fn) { (this.l[ev] ??= []).push(fn); }
    _start(op) {
      if (this.ms.readyState === 'closed') throw invalidState('closed');
      if (this.updating) throw invalidState(`${op} while updating`);
      if (this.ms.readyState === 'ended') this.ms.readyState = 'open';
      this.updating = true; this.op = op;
      setTimeout(() => { this.updating = false; this.op = null; for (const fn of this.l.updateend ?? []) fn(); }, 1);
    }
    appendBuffer(d) { this._start('append'); this.appended.push(d); }
    remove() { this._start('remove'); }
    abort() {
      if (this.op === 'remove') throw invalidState('abort during remove');
      if (this.ms.readyState !== 'open') throw invalidState('abort when not open');
      this.updating = false; this.op = null;
    }
  }
  class StrictMediaSource {
    constructor() { this.readyState = 'closed'; this.sourceBuffers = []; this.l = {}; this._d = NaN; all.push(this); }
    static isTypeSupported() { return true; }
    addEventListener(ev, fn) { (this.l[ev] ??= []).push(fn); }
    fire(ev) { if (ev === 'sourceopen') this.readyState = 'open'; for (const fn of this.l[ev] ?? []) fn(); }
    get duration() { return this._d; }
    set duration(v) {
      if (this.readyState !== 'open' || this.sourceBuffers.some((b) => b.updating)) throw invalidState('duration');
      this._d = v;
    }
    addSourceBuffer(mime) {
      if (this.readyState !== 'open') throw invalidState('addSourceBuffer when not open');
      const b = new StrictSourceBuffer(this, mime); this.sourceBuffers.push(b); return b;
    }
    removeSourceBuffer(b) { this.sourceBuffers = this.sourceBuffers.filter((x) => x !== b); }
    endOfStream() {
      if (this.readyState !== 'open' || this.sourceBuffers.some((b) => b.updating)) throw invalidState('endOfStream');
      this.readyState = 'ended';
    }
  }
  const prev = { MS: globalThis.MediaSource, c: URL.createObjectURL, r: URL.revokeObjectURL };
  globalThis.MediaSource = StrictMediaSource;
  let n = 0;
  URL.createObjectURL = () => `blob:ms${++n}`;
  URL.revokeObjectURL = () => {};
  return {
    all,
    restore() { globalThis.MediaSource = prev.MS; URL.createObjectURL = prev.c; URL.revokeObjectURL = prev.r; },
  };
}

function strictVideo() {
  const l = {};
  return {
    src: null, currentTime: 0, paused: true, error: null, buffered: { length: 0 },
    addEventListener(ev, fn) { (l[ev] ??= []).push(fn); },
    removeEventListener() {},
    fire(ev) { for (const fn of l[ev] ?? []) fn(); },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    removeAttribute() { this.src = null; },
  };
}

const AVC = { number: 1, type: 'video', codecId: 'V_MPEG4/ISO/AVC', codecPrivate: new Uint8Array([1, 100, 0, 12, 255]), language: 'und' };
const AAC_A = { number: 2, type: 'audio', codecId: 'A_AAC', codecPrivate: new Uint8Array([0x12, 0x10]), language: 'eng' };
const AAC_B = { number: 3, type: 'audio', codecId: 'A_AAC', codecPrivate: new Uint8Array([0x11, 0x90]), language: 'rus' };

// Demuxer yielding 1 video + 1 audio sample per second for 10s.
const tenSeconds = {
  durationSec: () => 10,
  async *samples(from, _to, sel) {
    for (let t = Math.floor(from); t < 10; t++) {
      for (const n of sel) yield { trackNumber: n, timestamp: t, keyframe: true, data: new Uint8Array(8) };
    }
  },
};
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('strict MSE: rapid seeks while buffers update never throw', async () => {
  const env = installStrictMse();
  try {
    const { createMsePlayer } = await import('./msePlayer.js');
    const video = strictVideo();
    const errors = [];
    const player = createMsePlayer(video, tenSeconds, [AVC, AAC_A], { onError: (e) => errors.push(e.message) });
    env.all[0].fire('sourceopen');
    await settle(5);
    // Drag the seek bar: seeks land while appends and removes are in flight.
    // Back to back, as 'seeking' fires while dragging: later seeks land on
    // buffers still running the previous seek's remove().
    for (const t of [7, 3, 8, 2, 6]) assert.doesNotThrow(() => player.seek(t));
    await settle(1);
    for (const t of [4, 9]) assert.doesNotThrow(() => player.seek(t));
    await settle();
    assert.deepEqual(errors, []);
    assert.equal(env.all[0].duration, 10); // finite duration: seek bar works
    player.dispose();
  } finally {
    env.restore();
  }
});

test('strict MSE: audio switch after end of stream rebuilds the MediaSource', async () => {
  const env = installStrictMse();
  try {
    const { createMsePlayer } = await import('./msePlayer.js');
    const video = strictVideo();
    const errors = [];
    const player = createMsePlayer(video, tenSeconds, [AVC, AAC_A, AAC_B], { onError: (e) => errors.push(e.message) });
    env.all[0].fire('sourceopen');
    await settle();
    assert.equal(env.all[0].readyState, 'ended'); // whole file appended
    video.currentTime = 6;
    video.paused = false;
    player.setAudioTrack(3);
    assert.equal(env.all.length, 2, 'new MediaSource');
    assert.equal(video.src, 'blob:ms2');
    env.all[1].fire('sourceopen');
    await settle();
    assert.deepEqual(errors, []);
    const [v, a] = env.all[1].sourceBuffers;
    assert.match(a.mime, /mp4a\.40\.2/);
    assert.ok(v.appended.length > 1 && a.appended.length > 1, 'streams again');
    assert.equal(video.currentTime, 6, 'kept the position');
    assert.equal(video.paused, false, 'kept playing');
    player.dispose();
  } finally {
    env.restore();
  }
});

test('strict MSE: a decoder error is reported as such, not as invalid state', async () => {
  const env = installStrictMse();
  try {
    const { createMsePlayer } = await import('./msePlayer.js');
    const video = strictVideo();
    const errors = [];
    createMsePlayer(video, tenSeconds, [AVC, AAC_A], { onError: (e) => errors.push(e.message) });
    env.all[0].fire('sourceopen');
    video.error = { code: 4, message: 'Unsupported audio configuration' };
    video.fire('error');
    await settle();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /media error 4: Unsupported audio configuration/);
  } finally {
    env.restore();
  }
});
