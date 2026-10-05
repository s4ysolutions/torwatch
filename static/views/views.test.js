import test from 'node:test';
import assert from 'node:assert/strict';
import { emitter } from '../util/events.js';
import { render } from './statusBar.js';
import { inputCardView } from './inputCardView.js';
import { downloadsRow } from './downloadsRow.js';

function walk(n) { return [n, ...(n.children ?? []).flatMap(walk)]; }

// Tiny local DOM stub — just enough for statusBar (no jsdom).
function makeStubEl(tag) {
  const classes = new Set();
  const children = [];
  const attrs = {};
  const listeners = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    textContent: '',
    value: '',
    style: {},
    children,
    attrs,
    appendChild(c) { children.push(c); return c; },
    append(...cs) { children.push(...cs); },
    setAttribute(k, v) { attrs[k] = String(v); node[k] = String(v); },
    getAttribute(k) { return attrs[k] ?? null; },
    removeAttribute(k) { delete attrs[k]; },
    addEventListener(t, fn) { (listeners[t] ??= []).push(fn); },
    removeEventListener() {},
    async __fire(t, ev) { for (const fn of listeners[t] ?? []) await fn(ev); },
    remove() { this.removed = true; },
    querySelectorAll(sel) {
      const m = /^(\w+)(?:\[name="([^"]+)"\])?$/.exec(String(sel));
      return walk(node).filter((n) => {
        if (n === node) return false;
        if (m && m[1] && n.tagName !== m[1].toUpperCase()) return false;
        if (m && m[2] && n.attrs?.name !== m[2]) return false;
        return true;
      });
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; },
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
  const prev = globalThis.document;
  globalThis.document = {
    createElement: (tag) => makeStubEl(tag),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  };
  return () => {
    if (prev === undefined) delete globalThis.document;
    else globalThis.document = prev;
  };
}

test('statusBar shows phase text and busy class', () => {
  const restore = installStub();
  try {
    const state = emitter({ phase: 'idle' });
    const c = globalThis.document.createElement('div');
    const dispose = render(c, state.subscribe);
    assert.equal(typeof dispose, 'function');
    const bar = c.children[0];
    assert.equal(bar.id, 'status');
    assert.equal(bar.textContent, '');
    assert.equal(bar.style.display, 'none');

    state.set({ phase: 'fetching' });
    assert.match(bar.textContent, /fetching/i);
    assert.ok(bar.classList.contains('busy'));
    assert.notEqual(bar.style.display, 'none');

    state.set({ phase: 'loading' });
    assert.match(bar.textContent, /fetching/i);
    assert.ok(bar.classList.contains('busy'));

    state.set({ phase: 'ready' });
    assert.match(bar.textContent, /ready/i);
    assert.ok(!bar.classList.contains('busy'));

    state.set({ phase: 'error', error: 'dead torrent' });
    assert.match(bar.textContent, /dead torrent/);
    assert.ok(!bar.classList.contains('busy'));

    state.set({ phase: 'playing' });
    assert.equal(bar.textContent, '');
    assert.equal(bar.style.display, 'none');

    dispose();
    assert.ok(bar.removed);
  } finally {
    restore();
  }
});

test('statusBar shows waiting-for-peers busy state (poll watchdog)', () => {
  const restore = installStub();
  try {
    const state = emitter({ phase: 'idle' });
    const c = globalThis.document.createElement('div');
    const dispose = render(c, state);
    const bar = c.children[0];
    state.set({ phase: 'waiting' });
    assert.match(bar.textContent, /waiting for peers/i);
    assert.ok(bar.classList.contains('busy'));
    assert.notEqual(bar.style.display, 'none');
    dispose();
  } finally {
    restore();
  }
});

test('input card shows engine toggle defaulting to browser', () => {
  const restore = installStub();
  try {
    const host = globalThis.document.createElement('div');
    inputCardView(host, { onMagnet() {}, onTorrentFile() {}, onSubsFile() {}, onEngine() {} });
    const radios = walk(host).filter(n => n.tagName === 'INPUT' && n.attrs?.name === 'engine');
    assert.equal(radios.length, 2);
    const values = radios.map(r => r.attrs.value).sort();
    assert.deepEqual(values, ['browser', 'server']);
    const checked = radios.filter(r => 'checked' in (r.attrs ?? {}));
    assert.equal(checked.length, 1);
    assert.equal(checked[0].attrs.value, 'browser');
  } finally { restore(); }
});

test('downloadsRow uses videoName for the download attribute', () => {
  const restore = installStub();
  try {
    const row = downloadsRow(() => ({ videoUrl: 'blob:x', videoName: 'm.mkv' }));
    const a = walk(row).find(n => n.tagName === 'A');
    assert.ok(a, 'video link missing');
    assert.equal(a.attrs.download, 'm.mkv');
  } finally { restore(); }
});

test('downloadsRow lazy video resolves only on click, then downloads', async () => {
  const restore = installStub();
  try {
    let calls = 0;
    const row = downloadsRow(() => ({ getVideo: async () => { calls++; return { url: 'blob:v', name: 'm.mkv' }; } }));
    const a = walk(row).find(n => n.tagName === 'A');
    assert.ok(a, 'video link missing');
    assert.equal(calls, 0); // nothing built at render
    let clicked = 0;
    a.click = () => { clicked++; };
    await a.__fire('click', { preventDefault() {} });
    assert.equal(calls, 1);
    assert.equal(a.attrs.href, 'blob:v');
    assert.equal(a.attrs.download, 'm.mkv');
    assert.equal(clicked, 1);
  } finally { restore(); }
});

test('statusBar shows the note while playing (data source, cache state)', () => {
  const restore = installStub();
  try {
    const st = emitter({ phase: 'playing', note: 'Playing from local cache' });
    const node = render(st);
    assert.equal(node.textContent, 'Playing from local cache');
    st.set({ phase: 'playing', note: null });
    assert.equal(node.textContent, '');
    st.set({ phase: 'idle', note: 'staged subs.srt — press Watch' });
    assert.equal(node.textContent, 'staged subs.srt — press Watch');
  } finally { restore(); }
});

test('filePickerView lists videos by season with sizes and resume markers', async () => {
  const { filePickerView } = await import('./filePickerView.js');
  const restore = installStub();
  try {
    const container = makeStubEl('div');
    const files = [
      { index: 0, path: 'Show/Season 1/S01E10.mp4', size: 1 << 20 },
      { index: 1, path: 'Show/Season 1/S01E02.mp4', size: 2 << 20 },
      { index: 2, path: 'Show/readme.txt', size: 10 },
      { index: 3, path: 'Show/Season 2/S02E01.mp4', size: 3 << 20 },
    ];
    const dispose = filePickerView(container, {
      name: 'Show', files, otherCount: 1,
      positionOf: (i) => (i === 1 ? 754 : 0),
      hrefFor: (i) => `#/play/x/${i}`,
    });
    const text = (n) => (n.textContent || '') + (n.children ?? []).map(text).join('');
    const links = walk(container).filter((n) => n.tagName === 'A' && n.className === 'picker-file');
    assert.deepEqual(links.map((a) => [text(a), a.attrs.href]), [['S01E02.mp4', '#/play/x/1'], ['S01E10.mp4', '#/play/x/0'], ['S02E01.mp4', '#/play/x/3']]);
    const all = text(container);
    assert.match(all, /3 videos · 1 other files/);
    assert.match(all, /Season 1.*Season 2/);
    assert.match(all, /resume at 12:34/);
    dispose();
  } finally { restore(); }
});

test('filePickerView: Continue link, last watched marked and scrolled into view', async () => {
  const { filePickerView } = await import('./filePickerView.js');
  const restore = installStub();
  try {
    const container = makeStubEl('div');
    const files = [
      { index: 0, path: 'Show/Season 1/S01E01.mp4', size: 1 },
      { index: 1, path: 'Show/Season 1/S01E02.mp4', size: 1 },
    ];
    const text = (n) => (n.textContent || '') + (n.children ?? []).map(text).join('');
    filePickerView(container, {
      files, lastIndex: 0, continueIndex: 1,
      positionOf: (i) => (i === 1 ? 65 : 0),
      hrefFor: (i) => `#/play/x/${i}`,
    });
    const cont = walk(container).find((n) => n.className === 'picker-continue');
    assert.ok(cont, 'continue link');
    assert.equal(text(cont), '▶ Continue: S01E02.mp4 · from 1:05');
    assert.equal(walk(cont).find((n) => n.tagName === 'A').attrs.href, '#/play/x/1');
    const last = walk(container).find((n) => n.className === 'picker-last');
    assert.match(text(last), /S01E01\.mp4.*last watched/);
    // nothing played: no Continue, no marker
    const c2 = makeStubEl('div');
    filePickerView(c2, { files, hrefFor: (i) => `#${i}` });
    assert.ok(!walk(c2).some((n) => n.className === 'picker-continue' || n.className === 'picker-last'));
  } finally { restore(); }
});

test('filePickerView: progress bars from position / duration, full when watched', async () => {
  const { filePickerView } = await import('./filePickerView.js');
  const restore = installStub();
  try {
    const container = makeStubEl('div');
    const files = [
      { index: 0, path: 'S/E01.mp4', size: 1 }, // watched
      { index: 1, path: 'S/E02.mp4', size: 1 }, // half way, duration known
      { index: 2, path: 'S/E03.mp4', size: 1 }, // started, no duration saved yet
      { index: 3, path: 'S/E04.mp4', size: 1 }, // not started
    ];
    const pos = { 1: 660, 2: 30 };
    filePickerView(container, {
      files, hrefFor: (i) => `#${i}`,
      positionOf: (i) => pos[i] ?? 0,
      durationOf: (i) => (i === 1 ? 1320 : 0),
      watchedOf: (i) => i === 0,
    });
    const text = (n) => (n.textContent || '') + (n.children ?? []).map(text).join('');
    const rows = walk(container).filter((n) => n.tagName === 'LI');
    const barOf = (li) => walk(li).find((n) => n.className === 'picker-progress');
    const fillOf = (li) => walk(li).find((n) => n.className === 'picker-progress-fill')?.attrs.style;
    assert.equal(fillOf(rows[0]), 'width:100.0%');
    assert.equal(fillOf(rows[1]), 'width:50.0%');
    assert.equal(barOf(rows[1]).attrs['aria-valuenow'], '50');
    assert.match(text(rows[1]), /resume at 11:00 \/ 22:00/);
    assert.equal(barOf(rows[2]), undefined, 'no duration yet → text only');
    assert.match(text(rows[2]), /resume at 0:30$/);
    assert.equal(barOf(rows[3]), undefined);
  } finally { restore(); }
});
