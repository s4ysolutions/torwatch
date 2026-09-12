export function emitter(initial) {
  let v = initial; const subs = new Set();
  return {
    get: () => v,
    set(nv) { v = nv; for (const fn of [...subs]) fn(v); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
