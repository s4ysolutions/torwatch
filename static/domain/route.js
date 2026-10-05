import { emitter } from '../util/events.js';

export function parseRoute(hash) {
  const path = String(hash ?? '').replace(/^#/, '') || '/';
  const m = /^\/play\/([^/]+)\/([^/]+)\/?$/.exec(path);
  if (m) return { name: 'play', params: { id: m[1], file: m[2] } };
  const f = /^\/files\/([^/]+)\/?$/.exec(path);
  if (f) return { name: 'files', params: { id: f[1] } };
  return { name: 'home', params: {} };
}

function current() {
  const loc = globalThis.location;
  return parseRoute(loc ? loc.hash : '');
}

export const route = emitter(current());

// go() sets the hash and the route at once; the hashchange that follows
// must not set the same route again (that mounted every view twice).
const sameRoute = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function update(r) {
  if (!sameRoute(r, route.get())) route.set(r);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('hashchange', () => update(current()));
}

export function go(path) {
  const hash = String(path ?? '').startsWith('#') ? String(path) : `#${String(path ?? '')}`;
  try {
    if (globalThis.location) globalThis.location.hash = hash;
    else if (typeof location !== 'undefined') location.hash = hash;
  } catch {}
  update(parseRoute(hash));
}

route.go = go;
