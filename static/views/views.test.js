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
