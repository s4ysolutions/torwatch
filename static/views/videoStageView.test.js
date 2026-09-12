import test from 'node:test';
import assert from 'node:assert/strict';
import {
  videoStageView,
  drainGroups,
  finalizePlayback,
  createSwitchGuard,
} from './videoStageView.js';

function makeStubEl(tag) {
  const classes = new Set();
  const listeners = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    attrs: {},
    style: {},
    className: '',
    textContent: '',
    value: '',
    parentNode: null,
    removed: false,
    get firstChild() { return this.children[0] ?? null; },
    setAttribute(k, v) { this.attrs[k] = String(v); this[k] = v; },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
    removeEventListener(ev, fn) {
      listeners.set(ev, (listeners.get(ev) ?? []).filter((f) => f !== fn));
    },
    fire(ev, arg) { for (const fn of [...(listeners.get(ev) ?? [])]) fn(arg); },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    append(...cs) { for (const c of cs) this.appendChild(c); },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    remove() {
      this.removed = true;
      try { this.parentNode?.removeChild(this); } catch {}
    },
    classList: {
      add: (...cs) => { for (const c of cs) classes.add(c); },
      remove: (...cs) => { for (const c of cs) classes.delete(c); },
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c);
          else classes.add(c);
        } else if (force) classes.add(c);
        else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
  };
  return node;
}

function memLocalStorage(preset = {}) {
  const m = new Map(Object.entries(preset));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => void m.clear(),
  };
}

function installEnv(lsPreset) {
  const prevDoc = globalThis.document;
  const prevLs = globalThis.localStorage;
  globalThis.document = {
    createElement: (tag) => makeStubEl(tag),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  };
  globalThis.localStorage = memLocalStorage(lsPreset);
  return () => {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
    if (prevLs === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevLs;
  };
}

// --- F-A: drainGroups flushes trailing partial groups ---

test('drainGroups flushes leftover partial groups and empties them', () => {
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

// --- F-A: finalizePlayback endOfStream guard ---

test('finalizePlayback ends stream only when open, never throws', () => {
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

// --- F-B: switch guard drops stale callbacks ---

test('createSwitchGuard marks pre-invalidate tokens stale', () => {
  const g = createSwitchGuard();
  const t0 = g.token();
  assert.equal(g.stale(t0), false);
  g.invalidate();
  assert.equal(g.stale(t0), true);
  assert.equal(g.stale(g.token()), false);
});

// --- stage element form ---

test('videoStageView element form builds stage, delegates play/seek', () => {
  const restore = installEnv();
  try {
    const stage = videoStageView({});
    assert.equal(stage.tagName, 'DIV');
    const video = stage.children.find((c) => c.tagName === 'VIDEO');
    assert.ok(video);
    assert.ok(stage.children.some((c) => c.className === 'grip'));

    const calls = [];
    stage.attachPlayer({
      play: () => calls.push('play'),
      seek: (s) => calls.push(['seek', s]),
    });
    stage.playVideo();
    stage.seekTo(42);
    assert.deepEqual(calls, ['play', [['seek', 42]][0]]);

    stage.dispose();
    assert.ok(stage.removed);
  } finally {
    restore();
  }
});

test('videoStageView container form returns disposeFn, restores width', () => {
  const restore = installEnv({ 'torwatch.stageWidth': '500' });
  try {
    const container = makeStubEl('div');
    const dispose = videoStageView(container, {});
    assert.equal(typeof dispose, 'function');
    assert.equal(container.children.length, 1);
    assert.equal(container.children[0].style.width, '500px');
    dispose();
    assert.equal(container.children.length, 0);
  } finally {
    restore();
  }
});

test('videoStageView brief shorthand accepts playerFactory', () => {
  const restore = installEnv();
  try {
    let factoryVideo = null;
    const stage = videoStageView((video) => {
      factoryVideo = video;
      return { play: () => 'played', seek: () => {} };
    });
    assert.ok(factoryVideo);
    assert.equal(stage.playVideo(), 'played');
    stage.dispose();
  } finally {
    restore();
  }
});
