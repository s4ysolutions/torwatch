import test from 'node:test';
import assert from 'node:assert/strict';
import { emitter } from './events.js';
import { store } from './store.js';
import { parseRoute, go, route } from '../domain/route.js';
import { playerState } from '../domain/playerState.js';
import { tracks } from '../domain/tracks.js';

function memLocalStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: k => void m.delete(k),
    clear: () => void m.clear(),
  };
}

test('emitter notifies and unsubscribes', () => {
  const e = emitter(0);
  const seen = [];
  const unsub = e.subscribe(v => seen.push(v));
  e.set(1); e.set(2); unsub(); e.set(3);
  assert.deepEqual(seen, [1, 2]);
});

test('store round-trip and fallback', () => {
  globalThis.localStorage = memLocalStorage(); // tiny Map-backed stub in test
  const s = store.ns('torwatch');
  assert.equal(s.get('missing', 42), 42);
  s.set('k', { a: 1 });
  assert.deepEqual(s.get('k'), { a: 1 });
});

test('route parses play hash', () => {
  assert.deepEqual(parseRoute('#/play/abc/0'), { name: 'play', params: { id: 'abc', file: '0' } });
  assert.deepEqual(parseRoute('#/bogus'), { name: 'home', params: {} });
  assert.deepEqual(parseRoute(''), { name: 'home', params: {} });
  globalThis.location = { hash: '#/' };
  go('/play/abc/0');
  assert.equal(globalThis.location.hash, '#/play/abc/0');
  assert.deepEqual(route.get(), { name: 'play', params: { id: 'abc', file: '0' } });
  delete globalThis.location;
});

test('playerState initial shape', () => {
  assert.deepEqual(playerState.get(), {
    phase: 'idle', magnetId: null, fileIndex: 0, position: 0, duration: 0, error: null, note: null,
  });
});

test('tracks initial shape', () => {
  assert.deepEqual(tracks.get(), {
    audio: [], subtitles: [], activeAudio: null, activeSubtitle: null,
  });
});
