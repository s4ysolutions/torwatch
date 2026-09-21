import test from 'node:test';
import assert from 'node:assert/strict';
import { webtorrentAdapter, PINNED_TRACKERS } from './webtorrentAdapter.js';

function fakeTorrent({ infoHash = 'ab'.repeat(20), name = 'vid', files = [] } = {}) {
  const handlers = {};
  return {
    infoHash, name, files, announce: [], ready: false,
    on(ev, fn) { (handlers[ev] ??= []).push(fn); return this; },
    _emit(ev, ...a) { for (const fn of handlers[ev] ?? []) fn(...a); },
  };
}

function fakeClient() {
  const added = [];
  const byId = new Map();
  return {
    added,
    add(id, opts, cb) {
      added.push([id, opts]);
      const t = fakeTorrent();
      byId.set(t.infoHash, t);
      if (typeof cb === 'function') cb(t);
      return t;
    },
    get: (id) => byId.get(id),
    remove(id, opts, cb) { byId.delete(id); if (typeof cb === 'function') cb(); },
  };
}

test('addMagnet injects pinned wss trackers and returns infohash', async () => {
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
  assert.equal(id, 'ab'.repeat(20));
  const [, opts] = client.added[0];
  for (const tr of PINNED_TRACKERS) assert.ok(opts.announce.includes(tr), `missing ${tr}`);
  assert.ok(opts.announce.every(t => t.startsWith('wss://')));
});

test('getMagnet maps fetching-meta then ready with mapped files', async () => {
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
  const t = client.get(id);
  let info = await a.getMagnet(id);
  assert.equal(info.state, 'fetching-meta');
  assert.deepEqual(info.files, []);
  assert.ok(!('waiting' in info) && info.state !== 'waiting');
  t.files = [{ name: 'm.mkv', path: 'm.mkv', length: 10 }];
  t.ready = true;
  t._emit('metadata');
  info = await a.getMagnet(id);
  assert.equal(info.state, 'ready');
  assert.deepEqual(info.files, [{ index: 0, path: 'm.mkv', size: 10 }]);
});

test('getMagnet maps torrent error to error state', async () => {
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
  client.get(id)._emit('error', new Error('tracker fail'));
  const info = await a.getMagnet(id);
  assert.equal(info.state, 'error');
  assert.ok(info.error.length > 0);
});

test('addTorrentFile merges pinned trackers and returns infohash', async () => {
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addTorrentFile(new Uint8Array([1, 2, 3]));
  assert.equal(id, 'ab'.repeat(20));
  const [, opts] = client.added[0];
  for (const tr of PINNED_TRACKERS) assert.ok(opts.announce.includes(tr), `missing ${tr}`);
});

test('deleteMagnet removes with destroyStore, unknown id resolves', async () => {
  const client = fakeClient();
  const removed = [];
  client.remove = (id, opts, cb) => { removed.push([id, opts]); if (typeof cb === 'function') cb(); };
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  await a.deleteMagnet('ab'.repeat(20));
  assert.deepEqual(removed, [['ab'.repeat(20), { destroyStore: true }]]);
  await a.deleteMagnet('unknown-id'); // resolves silently
});
