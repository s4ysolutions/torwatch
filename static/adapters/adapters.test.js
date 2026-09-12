import test from 'node:test';
import assert from 'node:assert/strict';
import { backendAdapter } from './backendAdapter.js';
import { opfsAdapter } from './opfsAdapter.js';

// --- backendAdapter ---

test('fetchRange sends Range header and returns bytes', async () => {
  const fakeFetch = async (url, opts) => {
    assert.equal(opts.headers.Range, 'bytes=10-19');
    return new Response(new Uint8Array(10).fill(7), { status: 206 });
  };
  const a = backendAdapter(fakeFetch);
  const out = await a.fetchRange('id1', 0, 10, 19);
  assert.equal(out.length, 10); assert.equal(out[0], 7);
});

test('addMagnet POSTs magnet as JSON and returns id', async () => {
  let seen;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return Response.json({ id: 'abc123' });
  };
  const a = backendAdapter(fakeFetch);
  const out = await a.addMagnet('magnet:?xt=urn:btih:abc');
  assert.deepEqual(out, { id: 'abc123' });
  assert.equal(seen.url, '/api/magnets');
  assert.equal(seen.opts.method, 'POST');
  assert.deepEqual(JSON.parse(seen.opts.body), { magnet: 'magnet:?xt=urn:btih:abc' });
});

test('getMagnet GETs by id', async () => {
  let seenUrl;
  const fakeFetch = async (url) => {
    seenUrl = url;
    return Response.json({ id: 'id1', magnet: 'magnet:?x' });
  };
  const a = backendAdapter(fakeFetch);
  const out = await a.getMagnet('id1');
  assert.equal(seenUrl, '/api/magnets/id1');
  assert.equal(out.id, 'id1');
});

test('deleteMagnet sends DELETE', async () => {
  let seen;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return new Response(null, { status: 204 });
  };
  const a = backendAdapter(fakeFetch);
  await a.deleteMagnet('id1');
  assert.equal(seen.url, '/api/magnets/id1');
  assert.equal(seen.opts.method, 'DELETE');
});

test('searchSubs encodes query', async () => {
  let seenUrl;
  const fakeFetch = async (url) => {
    seenUrl = url;
    return Response.json({ results: [] });
  };
  const a = backendAdapter(fakeFetch);
  const out = await a.searchSubs('matrix reloaded');
  assert.equal(seenUrl, '/api/opensubs?query=matrix%20reloaded');
  assert.deepEqual(out, { results: [] });
});

test('fetchRange throws on error status', async () => {
  const fakeFetch = async () => new Response('nope', { status: 404 });
  const a = backendAdapter(fakeFetch);
  await assert.rejects(() => a.fetchRange('id1', 0, 0, 9));
});

// --- opfsAdapter (memory fallback) ---

test('opfs memory fallback round-trip', async () => {
  const o = opfsAdapter(null); // no root → memory mode
  await o.write('m1', 0, new Uint8Array([1, 2, 3]));
  await o.write('m1', 3, new Uint8Array([4]));
  assert.deepEqual([...await o.read('m1', 0, 3)], [1, 2, 3, 4]);
  assert.deepEqual((await o.stat('m1')).size, 4);
});

test('opfs read miss returns null', async () => {
  const o = opfsAdapter(null);
  assert.equal(await o.read('nope', 0, 1), null);
});

test('opfs memory fallback sparse write zero-fills gap', async () => {
  const o = opfsAdapter(null);
  await o.write('m1', 0, new Uint8Array([1]));
  await o.write('m1', 3, new Uint8Array([4]));
  assert.deepEqual([...await o.read('m1', 0, 3)], [1, 0, 0, 4]);
});

test('opfs memory fallback overlapping write overwrites', async () => {
  const o = opfsAdapter(null);
  await o.write('m1', 0, new Uint8Array([1, 2, 3, 4]));
  await o.write('m1', 1, new Uint8Array([9, 9]));
  assert.deepEqual([...await o.read('m1', 0, 3)], [1, 9, 9, 4]);
});

test('opfs memory fallback remove/stat-miss/listIds', async () => {
  const o = opfsAdapter(null);
  assert.equal(await o.stat('nope'), null);
  await o.write('a', 0, new Uint8Array([1]));
  await o.write('b', 0, new Uint8Array([2]));
  assert.deepEqual((await o.listIds()).sort(), ['a', 'b']);
  await o.remove('a');
  assert.equal(await o.read('a', 0, 0), null);
  assert.deepEqual(await o.listIds(), ['b']);
  await o.remove('missing'); // no throw
});
