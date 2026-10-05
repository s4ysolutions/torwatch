import test from 'node:test';
import assert from 'node:assert/strict';

test('go() + the hashchange it causes mount the route once', async () => {
  const handlers = [];
  globalThis.window = { addEventListener: (ev, fn) => { if (ev === 'hashchange') handlers.push(fn); } };
  globalThis.location = { hash: '' };
  try {
    const { route, go, parseRoute } = await import('./route.js');
    const seen = [];
    route.subscribe((r) => seen.push(r.name + ':' + JSON.stringify(r.params)));
    go('#/play/abc/2');
    for (const fn of handlers) fn(); // the browser's hashchange for that hash
    assert.deepEqual(seen, ['play:{"id":"abc","file":"2"}']);
    location.hash = '#/files/abc'; // a plain link click: hashchange only
    for (const fn of handlers) fn();
    assert.equal(seen.length, 2);
    assert.deepEqual(parseRoute('#/files/abc'), { name: 'files', params: { id: 'abc' } });
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});
