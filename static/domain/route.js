import { emitter } from '../util/events.js';

export function parseRoute(hash) {
  const path = String(hash ?? '').replace(/^#/, '') || '/';
  const m = /^\/play\/([^/]+)\/([^/]+)\/?$/.exec(path);
  if (m) return { name: 'play', params: { id: m[1], file: m[2] } };
  return { name: 'home', params: {} };
}

function current() {
  const loc = globalThis.location;
  return parseRoute(loc ? loc.hash : '');
}

export const route = emitter(current());

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('hashchange', () => route.set(current()));
}

export function go(path) {
  const hash = String(path ?? '').startsWith('#') ? String(path) : `#${String(path ?? '')}`;
  try {
    if (globalThis.location) globalThis.location.hash = hash;
    else if (typeof location !== 'undefined') location.hash = hash;
  } catch {}
  route.set(parseRoute(hash));
}

route.go = go;
