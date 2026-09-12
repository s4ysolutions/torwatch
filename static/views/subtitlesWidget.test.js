import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCueIndex, subtitlesWidget } from './subtitlesWidget.js';

// Local DOM stub — enough for el() + widget (no jsdom).
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
    checked: false,
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

function installStub() {
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: (tag) => makeStubEl(tag),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  };
  return () => {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  };
}

function walk(node, pred, out = []) {
  if (!node || node.nodeType !== 1) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) walk(c, pred, out);
  return out;
}

function fakeEmitter(state) {
  const subs = new Set();
  return {
    get: () => state.v,
    set: (nv) => { state.v = nv; for (const fn of [...subs]) fn(nv); },
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
}

function fakeVideo() {
  const v = makeStubEl('video');
  v.currentTime = 0;
  return v;
}

const tick = () => new Promise((r) => setImmediate(r));

// --- brief test (verbatim) ---

test('activeCueIndex finds cue containing t', () => {
  const cues = [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 3.5, end: 5 }];
  assert.equal(activeCueIndex(cues, 0.5), 0);
  assert.equal(activeCueIndex(cues, 2.9), 1);
  assert.equal(activeCueIndex(cues, 1.5), -1); // gap
  assert.equal(activeCueIndex(cues, 99), -1);
});

// --- boundaries ---

test('activeCueIndex boundaries: inclusive start, exclusive end', () => {
  const cues = [{ start: 0, end: 1 }, { start: 2, end: 3 }];
  assert.equal(activeCueIndex(cues, 0), 0);
  assert.equal(activeCueIndex(cues, 2), 1);
  assert.equal(activeCueIndex(cues, 1), -1); // end is exclusive
  assert.equal(activeCueIndex(cues, 3), -1);
  assert.equal(activeCueIndex(cues, -0.5), -1);
  assert.equal(activeCueIndex([], 1), -1);
  assert.equal(activeCueIndex(null, 1), -1);
  assert.equal(activeCueIndex(cues, NaN), -1);
  assert.equal(activeCueIndex([{ start: 5, end: 6 }], 5.5), 0);
});

test('activeCueIndex with overlaps returns latest-starting containing cue', () => {
  const cues = [
    { start: 0, end: 10 },
    { start: 2, end: 4 },
    { start: 3, end: 5 },
  ];
  assert.equal(activeCueIndex(cues, 3.5), 2);
  assert.equal(activeCueIndex(cues, 7), 0);
  assert.equal(activeCueIndex(cues, 10), -1);
});

// --- widget highlight (DOM stub) ---

test('widget highlights active cue on timeupdate, click seeks', () => {
  const restore = installStub();
  try {
    const cues = [
      { start: 0, end: 1, text: 'one' },
      { start: 2, end: 3, text: 'two' },
      { start: 3.5, end: 5, text: 'three' },
    ];
    const holder = { v: { subtitles: [{ label: 'en', cues }], activeSubtitle: 'en' } };
    const emitter = fakeEmitter(holder);
    const video = fakeVideo();
    let sought = null;
    const panel = subtitlesWidget(emitter, video, (s) => { sought = s; });

    const items = walk(panel, (n) => n.tagName === 'LI' && n.className === 'cue');
    assert.equal(items.length, 3);

    video.currentTime = 2.5;
    video.fire('timeupdate');
    assert.equal(panel.activeIndex(), 1);
    assert.ok(items[1].classList.contains('active'));
    assert.ok(!items[0].classList.contains('active'));

    video.currentTime = 1.5; // gap
    video.fire('timeupdate');
    assert.equal(panel.activeIndex(), -1);
    assert.ok(!items[1].classList.contains('active'));

    items[0].fire('click');
    assert.equal(sought, 0);

    panel.dispose();
    assert.ok(panel.removed);
  } finally {
    restore();
  }
});

test('widget Copy all forwards cue text via onCopy', () => {
  const restore = installStub();
  try {
    const cues = [{ start: 61, end: 62, text: 'hi' }];
    const holder = { v: { subtitles: [{ label: 'en', cues }], activeSubtitle: 'en' } };
    let copied = null;
    const panel = subtitlesWidget({
      emitter: fakeEmitter(holder),
      onCopy: (t) => { copied = t; },
    });
    const btn = walk(panel, (n) => n.tagName === 'BUTTON' && n.className === 'subs-copy')[0];
    assert.ok(btn);
    btn.fire('click');
    assert.match(copied, /hi/);
    panel.dispose();
  } finally {
    restore();
  }
});

test('widget Find online: search -> pick result -> loadExternal', async () => {
  const restore = installStub();
  try {
    const holder = { v: { subtitles: [], activeSubtitle: null } };
    const emitter = fakeEmitter(holder);
    let searched = null;
    let fetched = null;
    let loaded = null;
    const panel = subtitlesWidget({
      emitter,
      searchSubs: async (q) => {
        searched = q;
        return { results: [{ fileName: 'm.en.srt', language: 'en', downloadUrl: 'https://x/s.srt' }] };
      },
      fetchText: async (url) => {
        fetched = url;
        return '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
      },
      loadExternal: async (input) => { loaded = input; return { label: input.name, cues: [] }; },
    });
    const input = walk(panel, (n) => n.tagName === 'INPUT' && n.className === 'subs-title')[0];
    input.value = 'Some Movie';
    const find = walk(panel, (n) => n.tagName === 'BUTTON' && n.className === 'subs-find')[0];
    find.fire('click');
    await tick(); await tick();
    assert.equal(searched, 'Some Movie');
    const pick = walk(panel, (n) => n.tagName === 'BUTTON' && n.className === 'subs-result')[0];
    assert.ok(pick);
    pick.fire('click');
    await tick(); await tick(); await tick();
    assert.equal(fetched, 'https://x/s.srt');
    assert.equal(loaded.name, 'm.en.srt');
    assert.match(loaded.text, /Hello/);
    panel.dispose();
  } finally {
    restore();
  }
});
