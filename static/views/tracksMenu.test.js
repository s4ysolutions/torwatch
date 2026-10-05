import test from 'node:test';
import assert from 'node:assert/strict';
import { tracksMenu } from './tracksMenu.js';

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

function walk(node, pred, out = []) {
  if (!node || node.nodeType !== 1) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) walk(c, pred, out);
  return out;
}

function fakeEmitter(v) {
  const holder = { v };
  const subs = new Set();
  return {
    get: () => holder.v,
    set: (nv) => { holder.v = nv; for (const fn of [...subs]) fn(nv); },
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
}

test('tracksMenu brief form renders audio radios, change calls onSwitch', () => {
  const restore = installStub();
  try {
    const emitter = fakeEmitter({
      audio: [{ number: 1, language: 'eng' }, { number: 2, language: 'rus' }],
      subtitles: [{ label: 'en' }],
      activeAudio: 1,
      activeSubtitle: 'en',
    });
    let switched = null;
    const menu = tracksMenu(emitter, (n) => { switched = n; });
    const radios = walk(menu, (n) => n.tagName === 'INPUT' && n.type === 'radio');
    assert.equal(radios.length, 2);
    assert.equal(radios[0].checked, true);
    assert.equal(radios[1].checked, false);
    radios[1].fire('change');
    assert.equal(switched, 2);
    menu.dispose();
  } finally {
    restore();
  }
});

test('tracksMenu subtitle checkbox calls onSubtitle, popover toggles', () => {
  const restore = installStub();
  try {
    const emitter = fakeEmitter({
      audio: [],
      subtitles: [{ label: 'en' }, { label: 'ru' }],
      activeAudio: null,
      activeSubtitle: 'en',
    });
    let sub = null;
    const menu = tracksMenu({ emitter, onSubtitle: (label, on) => { sub = [label, on]; } });
    const boxes = walk(menu, (n) => n.tagName === 'INPUT' && n.type === 'checkbox');
    assert.equal(boxes.length, 2);
    assert.equal(boxes[0].checked, true);
    boxes[1].checked = true;
    boxes[1].fire('change');
    assert.deepEqual(sub, ['ru', true]);

    const pop = walk(menu, (n) => n.className === 'tracks-pop')[0];
    const btn = walk(menu, (n) => n.tagName === 'BUTTON')[0];
    assert.equal(pop.style.display, 'none');
    btn.fire('click');
    assert.notEqual(pop.style.display, 'none');
    menu.dispose();
  } finally {
    restore();
  }
});

test('tracksMenu container form returns disposeFn and repaints on emitter set', () => {
  const restore = installStub();
  try {
    const emitter = fakeEmitter({ audio: [], subtitles: [], activeAudio: null, activeSubtitle: null });
    const container = makeStubEl('div');
    const dispose = tracksMenu(container, { emitter, onSwitch: () => {} });
    assert.equal(typeof dispose, 'function');
    assert.equal(container.children.length, 1);
    emitter.set({
      audio: [{ number: 7, language: 'jpn' }],
      subtitles: [],
      activeAudio: 7,
      activeSubtitle: null,
    });
    const menu = container.children[0];
    const radios = walk(menu, (n) => n.tagName === 'INPUT' && n.type === 'radio');
    assert.equal(radios.length, 1);
    assert.equal(radios[0].checked, true);
    dispose();
    assert.equal(container.children.length, 0);
  } finally {
    restore();
  }
});

test('tracksMenu disables unplayable audio tracks and names the codec', () => {
  const restore = installStub();
  try {
    const emitter = fakeEmitter({
      audio: [
        { number: 1, language: 'rus', codecId: 'A_AC3', playable: false },
        { number: 2, language: 'eng', codecId: 'A_AAC', playable: true },
      ],
      subtitles: [],
      activeAudio: 2,
      activeSubtitle: null,
    });
    let switched = null;
    const menu = tracksMenu(emitter, (n) => { switched = n; });
    const radios = walk(menu, (n) => n.tagName === 'INPUT' && n.type === 'radio');
    assert.equal(radios.length, 2);
    assert.equal(radios[0].disabled, true);
    assert.ok(!radios[1].disabled);
    assert.equal(radios[1].checked, true);
    radios[0].fire('change');
    assert.equal(switched, null);
    const label = radios[0].parentNode;
    assert.match(label.className, /tracks-off/);
    assert.match(label.children.map((c) => c.textContent ?? '').join(''), /AC3, not supported/);
    menu.dispose();
  } finally {
    restore();
  }
});
