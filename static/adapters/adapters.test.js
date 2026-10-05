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

test('json error with plain-text body reports status, not SyntaxError', async () => {
  const fakeFetch = async () => new Response('not found', { status: 404 });
  const a = backendAdapter(fakeFetch);
  await assert.rejects(() => a.getMagnet('missing'), /404/);
});

test('addTorrentFile POSTs bytes and returns id', async () => {
  let seen;
  const fakeFetch = async (url, opts) => {
    seen = { url, opts };
    return Response.json({ id: 't1' });
  };
  const a = backendAdapter(fakeFetch);
  const out = await a.addTorrentFile(new Uint8Array([1, 2, 3]));
  assert.deepEqual(out, { id: 't1' });
  assert.equal(seen.url, '/api/torrents');
  assert.equal(seen.opts.method, 'POST');
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

test('opfs gap is a miss, never zero-filled', async () => {
  const o = opfsAdapter(null);
  await o.write('m1', 0, new Uint8Array([1]));
  await o.write('m1', 3, new Uint8Array([4]));
  assert.equal(await o.read('m1', 0, 3), null); // bytes 1..2 never written
  assert.equal(await o.read('m1', 1, 1), null);
  assert.deepEqual([...await o.read('m1', 3, 3)], [4]);
});

test('opfs read past covered end is a miss until eof is known', async () => {
  const o = opfsAdapter(null);
  await o.write('m1', 0, new Uint8Array([1, 2]));
  assert.equal(await o.read('m1', 0, 9), null);
  await o.setEof('m1', 2);
  assert.deepEqual([...await o.read('m1', 0, 9)], [1, 2]);
  assert.equal((await o.read('m1', 5, 9)).length, 0); // past eof: empty = EOF
});

test('opfs missing lists gaps, clipped at eof', async () => {
  const o = opfsAdapter(null);
  assert.deepEqual(await o.missing('m1', 0, 9), [[0, 10]]);
  await o.write('m1', 2, new Uint8Array(3)); // [2,5)
  await o.write('m1', 7, new Uint8Array(1)); // [7,8)
  assert.deepEqual(await o.missing('m1', 0, 9), [[0, 2], [5, 7], [8, 10]]);
  await o.setEof('m1', 8);
  assert.deepEqual(await o.missing('m1', 0, 9), [[0, 2], [5, 7]]);
  assert.deepEqual(await o.missing('m1', 2, 4), []);
});

test('opfs read stitches adjacent and overlapping chunks', async () => {
  const o = opfsAdapter(null);
  await o.write('m1', 0, new Uint8Array([1, 2, 3, 4]));
  await o.write('m1', 2, new Uint8Array([3, 4, 5, 6]));
  await o.write('m1', 6, new Uint8Array([7]));
  assert.deepEqual([...await o.read('m1', 1, 6)], [2, 3, 4, 5, 6, 7]);
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

test('opfs memory fallback: 1000 sequential 1KB writes stay fast and correct', async () => {
  const o = opfsAdapter(null);
  const N = 1000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    await o.write('big', i * 1024, new Uint8Array(1024).fill(i & 0xff));
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 10000, `1000 writes took ${ms}ms (O(n^2) suspected)`);
  assert.deepEqual((await o.stat('big')).size, N * 1024);
  // spot-check first/middle/last chunks
  for (const i of [0, 499, N - 1]) {
    const got = await o.read('big', i * 1024, i * 1024 + 1023);
    assert.equal(got.length, 1024);
    assert.ok(got.every((b) => b === (i & 0xff)), `chunk ${i} corrupt`);
  }
});

// Minimal OPFS directory fake: dirs of files, File.slice/text/size.
function fakeOpfsRoot() {
  const notFound = () => Object.assign(new Error('missing'), { name: 'NotFoundError' });
  const fileHandle = (store, name) => ({
    kind: 'file',
    async getFile() {
      const b = store.get(name);
      return {
        size: b.length,
        slice: (a, z) => ({ arrayBuffer: async () => b.slice(a, z).buffer }),
        text: async () => new TextDecoder().decode(b),
      };
    },
    async createWritable() {
      let data = new Uint8Array(0); // truncating, like the real default
      return {
        async write(c) { const n = new Uint8Array(data.length + c.length); n.set(data); n.set(c, data.length); data = n; },
        async close() { store.set(name, data); },
      };
    },
  });
  const dirHandle = (store) => ({
    kind: 'directory',
    async getFileHandle(name, opts) {
      if (!store.has(name)) {
        if (!opts?.create) throw notFound();
        store.set(name, new Uint8Array(0));
      }
      return fileHandle(store, name);
    },
    async *entries() { for (const n of store.keys()) yield [n, fileHandle(store, n)]; },
  });
  const dirs = new Map();
  return {
    dirs,
    async getDirectoryHandle(name, opts) {
      if (!dirs.has(name)) {
        if (!opts?.create) throw notFound();
        dirs.set(name, new Map());
      }
      return dirHandle(dirs.get(name));
    },
    async removeEntry(name) { if (!dirs.delete(name)) throw notFound(); },
    async *keys() { yield* dirs.keys(); },
  };
}

test('opfs stores one file per chunk and survives a reload', async () => {
  const root = fakeOpfsRoot();
  const o = opfsAdapter(root);
  await o.write('a:0', 0, new Uint8Array([1, 2, 3]));
  await o.write('a:0', 10, new Uint8Array([9]));
  await o.write('a:0', 3, new Uint8Array([4, 5]));
  await o.setEof('a:0', 11);
  assert.deepEqual([...root.dirs.get('a%3A0').keys()].sort(), ['0', '10', '3', 'eof']);
  // fresh adapter = page reload: index rebuilt from the directory
  const o2 = opfsAdapter(root);
  assert.deepEqual([...await o2.read('a:0', 0, 4)], [1, 2, 3, 4, 5]);
  assert.equal(await o2.read('a:0', 4, 10), null); // 5..9 never written
  assert.deepEqual([...await o2.read('a:0', 10, 20)], [9]); // clipped at eof
  assert.deepEqual(await o2.listIds(), ['a:0']);
  await o2.remove('a:0');
  assert.equal(await o2.read('a:0', 0, 0), null);
  assert.deepEqual(await o2.listIds(), []);
});

test('backend attachNative sets src and cleanup detaches', async () => {
  const seen = [];
  const fakeFetch = async (url, opts) => {
    seen.push([url, opts]);
    return { ok: true, json: async () => ({ id: 'x' }) };
  };
  const a = backendAdapter(fakeFetch);
  const calls = [];
  const video = {
    set src(v) { calls.push(['src', v]); },
    removeAttribute(n) { calls.push(['remove', n]); },
    load() { calls.push(['load']); },
  };
  const cleanup = await a.attachNative('abc', 2, video);
  assert.deepEqual(calls[0], ['src', '/api/magnets/abc/files/2']);
  await cleanup();
  assert.ok(calls.some(c => c[0] === 'remove'));
});

test('backend downloadFile returns url variant', async () => {
  const a = backendAdapter(async () => ({ ok: true, json: async () => ({}) }));
  const dl = await a.downloadFile('abc', 2);
  assert.equal(dl.url, '/api/magnets/abc/files/2');
  assert.equal(dl.blob, undefined);
  assert.ok(typeof dl.name === 'string' && dl.name.length > 0);
});

test('backend clearServerCache sends DELETE /api/cache', async () => {
  const seen = [];
  const a = backendAdapter(async (url, opts) => { seen.push([url, opts?.method]); return { ok: true, json: async () => ({ removed: 4 }) }; });
  assert.deepEqual(await a.clearServerCache(), { removed: 4 });
  assert.deepEqual(seen, [['/api/cache', 'DELETE']]);
});
