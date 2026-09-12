import test from 'node:test';
import assert from 'node:assert/strict';
import { emitter } from '../util/events.js';
import { render } from './statusBar.js';

// Tiny local DOM stub — just enough for statusBar (no jsdom).
function makeStubEl(tag) {
  const classes = new Set();
  const children = [];
  return {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    textContent: '',
    style: {},
    children,
    appendChild(c) { children.push(c); return c; },
    append(...cs) { children.push(...cs); },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    remove() { this.removed = true; },
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

test('statusBar shows waiting-for-peers busy state (Task 16 watchdog)', () => {
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
