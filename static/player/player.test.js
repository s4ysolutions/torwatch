import { test } from 'node:test';
import assert from 'node:assert/strict';

test('player modules import in node without exploding', async () => {
  const native = await import('./nativePlayer.js');
  assert.equal(typeof native.createNativePlayer, 'function');
  const mse = await import('./msePlayer.js');
  assert.equal(typeof mse.createMsePlayer, 'function');
});

// I5: seek() before sourceopen must not throw (buffers not attached yet) —
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
    assert.doesNotThrow(() => player.seek(5)); // I5: no {buf:null} queue push
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
