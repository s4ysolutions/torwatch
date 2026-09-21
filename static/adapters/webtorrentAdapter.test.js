import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { webtorrentAdapter, PINNED_TRACKERS } from './webtorrentAdapter.js';
import { MkvDemuxer } from '../demux/mkvDemuxer.js';

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

test('re-add after error clears stale error state', async () => {
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const magnet = 'magnet:?xt=urn:btih:' + 'ab'.repeat(20);
  const { id } = await a.addMagnet(magnet);
  client.get(id)._emit('error', new Error('tracker fail'));
  let info = await a.getMagnet(id);
  assert.equal(info.state, 'error');
  await a.deleteMagnet(id);
  const re = await a.addMagnet(magnet);
  assert.equal(re.id, id);
  info = await a.getMagnet(id);
  assert.equal(info.state, 'fetching-meta');
  assert.ok(!('error' in info));
});

test('re-add via addTorrentFile clears stale error state', async () => {
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addTorrentFile(new Uint8Array([1, 2, 3]));
  client.get(id)._emit('error', new Error('bad torrent'));
  let info = await a.getMagnet(id);
  assert.equal(info.state, 'error');
  await a.deleteMagnet(id);
  const re = await a.addTorrentFile(new Uint8Array([1, 2, 3]));
  assert.equal(re.id, id);
  info = await a.getMagnet(id);
  assert.equal(info.state, 'fetching-meta');
  assert.ok(!('error' in info));
});

test('fetchRange returns exact inclusive window', async () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
  client.get(id).files = [{
    name: 'm.mkv', path: 'm.mkv', length: 100,
    createReadStream({ start, end }) {
      return Readable.from([bytes.slice(start, end + 1)]);
    },
  }];
  const out = await a.fetchRange(id, 0, 10, 19);
  assert.equal(out.length, 10);
  assert.deepEqual([...out], [...bytes.slice(10, 20)]);
});

test('fetchRange returns short read at EOF', async () => {
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
  client.get(id).files = [{
    name: 'm.mkv', path: 'm.mkv', length: 100,
    createReadStream({ start, end }) {
      return Readable.from([bytes.slice(start, Math.min(end + 1, bytes.length))]);
    },
  }];
  const out = await a.fetchRange(id, 0, 90, 199);
  assert.equal(out.length, 10);
  assert.deepEqual([...out], [...bytes.slice(90, 100)]);
});

test('attachNative rejects with clear error when stream server unavailable', async () => {
  const client = fakeClient();
  client.createServer = (opts) => { if (!opts?.controller) throw new Error('Invalid worker registration'); return {}; };
  const hadNav = Object.hasOwn(globalThis, 'navigator');
  const origNav = globalThis.navigator;
  try {
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });
    const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
    const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
    client.get(id).files = [{ name: 'm.mp4', path: 'm.mp4', length: 5,
      streamTo() { throw new Error('should not stream'); } }];
    await assert.rejects(() => a.attachNative(id, 0, {}), /native playback unavailable \(stream server failed\)/);
  } finally {
    if (hadNav) Object.defineProperty(globalThis, 'navigator', { value: origNav, configurable: true, writable: true });
    else delete globalThis.navigator;
  }
});

test('attachNative uses streamTo and cleanup detaches', async () => {
  const client = fakeClient();
  client.createServer = (opts) => { if (!opts?.controller) throw new Error('Invalid worker registration'); return {}; };
  const hadNav = Object.hasOwn(globalThis, 'navigator');
  const origNav = globalThis.navigator;
  globalThis.navigator = { serviceWorker: { ready: Promise.resolve({}) } };
  try {
    const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
    const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
    const calls = [];
    client.get(id).files = [{ name: 'm.mp4', path: 'm.mp4', length: 5,
      streamTo(el) { calls.push(['streamTo', el]); } }];
    const video = { pause() {}, removeAttribute(n) { calls.push(['remove', n]); }, load() { calls.push(['load']); } };
    const cleanup = await a.attachNative(id, 0, video);
    assert.deepEqual(calls[0][0], 'streamTo');
    await cleanup();
    assert.ok(calls.some(c => c[0] === 'remove'));
  } finally {
    if (hadNav) globalThis.navigator = origNav;
    else delete globalThis.navigator;
  }
});

test('downloadFile returns blob variant with filename', async () => {
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
  client.get(id).files = [{ name: 'm.mkv', path: 'dir/m.mkv', length: 5,
    async blob() { return new Blob(['hello']); } }];
  const dl = await a.downloadFile(id, 0);
  assert.equal(dl.name, 'm.mkv');
  assert.ok(dl.blob instanceof Blob);
  assert.equal(dl.url, undefined);
});

test('downloadFile falls back to arrayBuffer', async () => {
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
  client.get(id).files = [{ name: 'm.mkv', path: 'dir/m.mkv', length: 5,
    async arrayBuffer() { return new TextEncoder().encode('hello').buffer; } }];
  const dl = await a.downloadFile(id, 0);
  assert.equal(dl.name, 'm.mkv');
  assert.ok(dl.blob instanceof Blob);
  assert.equal(await dl.blob.text(), 'hello');
});

test('MkvDemuxer extracts embedded subs over adapter fetchRange', async () => {
  const buf = new Uint8Array(await readFile(new URL('../../testdata/twoaudio.mkv', import.meta.url)));
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
  client.get(id).files = [{ name: 'twoaudio.mkv', path: 'twoaudio.mkv', length: buf.length,
    createReadStream({ start, end }) { return Readable.from([buf.slice(start, end + 1)]); } }];
  const d = new MkvDemuxer((s, e) => a.fetchRange(id, 0, s, e));
  const { tracks } = await d.readHeader();
  const sub = tracks.find(t => t.type === 'subtitle');
  assert.ok(sub, 'subtitle track found');
  const cues = await d.subtitleCues(sub.number);
  assert.ok(cues.length >= 1);
  assert.match(cues[0].text, /Hello fixture/);
});
