import test from 'node:test';
import assert from 'node:assert/strict';
import { backendAdapter } from '../adapters/backendAdapter.js';
import { opfsAdapter } from '../adapters/opfsAdapter.js';
import { store } from '../util/store.js';
import { playerState } from '../domain/playerState.js';
import { tracks } from '../domain/tracks.js';
import { pollMagnetReady, loadMagnet, savePosition, loadPosition, bindPosition, pickVideoFile, NoPlayableError } from './loadMagnet.js';
import { cachingFetchRange } from './cacheFile.js';
import { parseSrt, loadSubtitles, addExternalSubs } from './loadSubtitles.js';
import { switchAudio } from './switchAudio.js';

function memLocalStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: k => void m.delete(k),
    clear: () => void m.clear(),
  };
}

function reset() {
  globalThis.localStorage = memLocalStorage();
  playerState.set({ phase: 'idle', magnetId: null, fileIndex: 0, position: 0, duration: 0, error: null, note: null });
  tracks.set({ audio: [], subtitles: [], activeAudio: null, activeSubtitle: null });
}

// --- brief test 1 ---

test('loadMagnet picks largest video file and remembers magnet', async () => {
  reset();
  const fake = backendAdapter(async (url) => new Response(JSON.stringify(
    url.endsWith('/api/magnets') ? { id: 'x' } :
    { id: 'x', state: 'ready', files: [
      { index: 0, path: 'a.txt', size: 5 },
      { index: 1, path: 'movie.mkv', size: 900 }] })));
  const r = await loadMagnet({ adapter: fake, magnet: 'magnet:?xt=urn:btih:xx' });
  assert.deepEqual(r, { id: 'x', fileIndex: 1 });
  assert.equal(store.ns('torwatch').get('history')[0], 'magnet:?xt=urn:btih:xx');
});

// --- brief test 2 ---

test('parseSrt', () => {
  const cues = parseSrt('1\n00:00:01,000 --> 00:00:02,500\nHi there\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1); assert.equal(cues[0].end, 2.5);
  assert.equal(cues[1].text, 'Second');
});

// --- brief test 3 ---

test('cachingFetchRange: miss then hit', async () => {
  let fetches = 0;
  const adapter = { fetchRange: async () => { fetches++; return new Uint8Array([9]); } };
  const opfs = opfsAdapter(null);
  const fr = cachingFetchRange(opfs, adapter, 'm', 0);
  await fr(0, 0); await fr(0, 0);
  assert.equal(fetches, 1);
});

test('cachingFetchRange: never serves an uncovered gap, records eof', async () => {
  const file = new Uint8Array(100).map((_, i) => i);
  const fetched = [];
  const adapter = { fetchRange: async (_id, _i, s, e) => { fetched.push([s, e]); return file.slice(s, e + 1); } };
  const fr = cachingFetchRange(opfsAdapter(null), adapter, 'm', 0);
  await fr(80, 89); // seek-ahead chunk cached first
  assert.deepEqual([...await fr(0, 9)], [...file.slice(0, 10)]); // gap → network, not zeros
  await fr(90, 199); // short read: eof at 100
  assert.deepEqual([...await fr(95, 150)], [...file.slice(95)]);
  assert.deepEqual(fetched, [[80, 89], [0, 9], [90, 199]]);
});

test('cachingFetchRange fetches only the uncached gaps', async () => {
  const file = new Uint8Array(100).map((_, i) => i);
  const fetched = [];
  const adapter = { fetchRange: async (_id, _i, s, e) => { fetched.push([s, e]); return file.slice(s, e + 1); } };
  const fr = cachingFetchRange(opfsAdapter(null), adapter, 'm', 0);
  await fr(10, 19);
  await fr(30, 39);
  assert.deepEqual([...await fr(0, 49)], [...file.slice(0, 50)]);
  assert.deepEqual(fetched, [[10, 19], [30, 39], [0, 9], [20, 29], [40, 49]]);
  fetched.length = 0;
  await fr(0, 49);
  assert.deepEqual(fetched, []); // now fully cached
});

// --- loadMagnet extras ---

test('loadMagnet polls until ready and sets playerState', async () => {
  reset();
  let gets = 0;
  const fake = backendAdapter(async (url) => {
    if (url.endsWith('/api/magnets')) return Response.json({ id: 'y' });
    gets++;
    return Response.json(gets < 2
      ? { id: 'y', state: 'fetching-meta', files: [] }
      : { id: 'y', state: 'ready', files: [{ index: 0, path: 'film.mp4', size: 10 }] });
  });
  const r = await loadMagnet({ adapter: fake, magnet: 'magnet:?poll', pollMs: 5 });
  assert.deepEqual(r, { id: 'y', fileIndex: 0 });
  assert.equal(gets, 2);
  assert.equal(playerState.get().magnetId, 'y');
  assert.equal(playerState.get().fileIndex, 0);
  assert.equal(playerState.get().phase, 'ready');
});

test('loadMagnet throws when no video file', async () => {
  reset();
  const fake = backendAdapter(async (url) => Response.json(
    url.endsWith('/api/magnets') ? { id: 'z' } :
    { id: 'z', state: 'ready', files: [{ index: 0, path: 'readme.txt', size: 3 }] }));
  await assert.rejects(() => loadMagnet({ adapter: fake, magnet: 'magnet:?novideo' }), /video/);
});

test('loadMagnet throws on error state', async () => {
  reset();
  const fake = backendAdapter(async (url) => Response.json(
    url.endsWith('/api/magnets') ? { id: 'e' } :
    { id: 'e', state: 'error', error: 'dead torrent', files: [] }));
  await assert.rejects(() => loadMagnet({ adapter: fake, magnet: 'magnet:?err', pollMs: 1 }), /dead torrent/);
});

test('loadMagnet history dedupes, caps at 20, restores position', async () => {
  reset();
  const s = store.ns('torwatch');
  s.set('history', Array.from({ length: 20 }, (_, i) => `m${i}`));
  s.set('pos:q:2', 77);
  const fake = backendAdapter(async (url) => Response.json(
    url.endsWith('/api/magnets') ? { id: 'q' } :
    { id: 'q', state: 'ready', files: [{ index: 2, path: 'v.webm', size: 50 }] }));
  await loadMagnet({ adapter: fake, magnet: 'm5' });
  const h = s.get('history');
  assert.equal(h.length, 20);
  assert.equal(h[0], 'm5');
  assert.equal(new Set(h).size, 20);
  assert.equal(playerState.get().position, 77);
});

// --- position persistence ---

test('position save/load round-trip', () => {
  reset();
  assert.equal(loadPosition('id1', 0), 0);
  savePosition('id1', 0, 12.5);
  assert.equal(loadPosition('id1', 0), 12.5);
});

function fakeVideo() {
  const handlers = {};
  return {
    currentTime: 0,
    addEventListener: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
    removeEventListener: (ev, fn) => { handlers[ev] = (handlers[ev] ?? []).filter(f => f !== fn); },
    fire: (ev) => { for (const fn of handlers[ev] ?? []) fn(); },
  };
}

test('bindPosition saves on timeupdate, unbind stops', () => {
  reset();
  const v = fakeVideo();
  const unbind = bindPosition(v, 'id2', 3);
  v.currentTime = 42;
  v.fire('timeupdate');
  assert.equal(loadPosition('id2', 3), 42);
  unbind();
  v.currentTime = 99;
  v.fire('timeupdate');
  assert.equal(loadPosition('id2', 3), 42);
});

// --- pickVideoFile ---

test('pickVideoFile throws NoPlayableError carrying torrent info', () => {
  const info = { id: 'abc', name: 'Some AVI pack', files: [{ index: 0, path: 'a.avi', size: 5 }] };
  assert.throws(
    () => pickVideoFile(info.files, info),
    (e) => e instanceof NoPlayableError && e.info === info && /Some AVI pack/.test(e.message),
  );
});

test('pickVideoFile still picks largest playable file', () => {
  const files = [
    { index: 0, path: 'a.avi', size: 900 },
    { index: 1, path: 'b.mkv', size: 100 },
    { index: 2, path: 'c.mp4', size: 200 },
  ];
  assert.equal(pickVideoFile(files, { id: 'x' }), 2);
});

// --- cachingFetchRange extras ---

test('cachingFetchRange degrades on quota error with playerState note', async () => {
  reset();
  let fetches = 0;
  const adapter = { fetchRange: async () => { fetches++; return new Uint8Array([1, 2]); } };
  const opfs = opfsAdapter(null);
  const quota = new Error('quota');
  quota.name = 'QuotaExceededError';
  opfs.write = async () => { throw quota; };
  const fr = cachingFetchRange(opfs, adapter, 'm', 0);
  assert.deepEqual([...await fr(0, 1)], [1, 2]);
  assert.deepEqual([...await fr(0, 1)], [1, 2]);
  assert.equal(fetches, 2); // no caching after quota failure
  assert.equal(playerState.get().note, 'cache unavailable');
});

// --- subtitles ---

test('loadSubtitles pulls cues from demuxer into tracks', async () => {
  reset();
  const demuxer = { subtitleCues: async (n) => { assert.equal(n, 3); return [{ start: 1, end: 2, text: 'hi' }]; } };
  const cues = await loadSubtitles({ demuxer, track: { number: 3, language: 'eng' } });
  assert.equal(cues.length, 1);
  const subs = tracks.get().subtitles;
  assert.equal(subs.length, 1);
  assert.deepEqual(subs[0].cues, cues);
});

test('addExternalSubs parses SRT text', async () => {
  reset();
  const r = await addExternalSubs('1\n00:00:01,000 --> 00:00:02,000\nHello\n', 'ext.srt');
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].text, 'Hello');
  assert.equal(tracks.get().subtitles[0].label, 'ext.srt');
});

test('addExternalSubs parses VTT text', async () => {
  reset();
  const r = await addExternalSubs('WEBVTT\n\n00:01.000 --> 00:02.000\nHey\n', 'ext.vtt');
  assert.equal(r.cues.length, 1);
  assert.equal(r.cues[0].start, 1);
  assert.equal(r.cues[0].text, 'Hey');
});

// --- switchAudio ---

test('switchAudio delegates to player and syncs tracks', async () => {
  reset();
  let got = null;
  const player = { setAudioTrack: async (n) => { got = n; } };
  await switchAudio({ player, trackNumber: 2 });
  assert.equal(got, 2);
  assert.equal(tracks.get().activeAudio, 2);
});

// --- poll watchdog ---

test('loadMagnet signals waiting after watchdogMs but keeps polling to ready', async () => {
  reset();
  const phases = [];
  const off = playerState.subscribe((s) => phases.push(s.phase));
  try {
    let gets = 0;
    const fake = backendAdapter(async (url) => {
      if (url.endsWith('/api/magnets')) return Response.json({ id: 'w' });
      gets++;
      if (gets < 12) return Response.json({ id: 'w', state: 'fetching-meta', files: [] });
      return Response.json({ id: 'w', state: 'ready', files: [{ index: 0, path: 'film.mp4', size: 10 }] });
    });
    const r = await loadMagnet({ adapter: fake, magnet: 'magnet:?stall', pollMs: 5, watchdogMs: 20 });
    assert.deepEqual(r, { id: 'w', fileIndex: 0 });
    assert.ok(phases.includes('waiting'), `expected a waiting phase, got ${JSON.stringify(phases)}`);
    assert.equal(playerState.get().phase, 'ready');
  } finally {
    off();
  }
});

test('loadMagnet treats missing state as not-ready (only ready breaks poll)', async () => {
  reset();
  let gets = 0;
  const fake = backendAdapter(async (url) => {
    if (url.endsWith('/api/magnets')) return Response.json({ id: 'ns' });
    gets++;
    if (gets < 3) return Response.json({ id: 'ns', files: [] }); // no state
    return Response.json({ id: 'ns', state: 'ready', files: [{ index: 0, path: 'film.mp4', size: 10 }] });
  });
  const r = await loadMagnet({ adapter: fake, magnet: 'magnet:?nostate', pollMs: 1 });
  assert.deepEqual(r, { id: 'ns', fileIndex: 0 });
  assert.equal(gets, 3);
});

// --- cache accounting, pruning, clearing ---

test('cachingFetchRange reports bytes by source (cache vs network)', async () => {
  const file = new Uint8Array(100).map((_, i) => i);
  const adapter = { fetchRange: async (_id, _i, s, e) => file.slice(s, e + 1) };
  const seen = { cache: 0, network: 0 };
  const fr = cachingFetchRange(opfsAdapter(null), adapter, 'src', 0, { onBytes: (k, n) => { seen[k] += n; } });
  await fr(0, 19); // network
  await fr(0, 19); // cache
  await fr(10, 29); // 10 cached + 10 fetched
  assert.deepEqual(seen, { cache: 30, network: 30 });
});

test('pruneCache drops expired files, then least recently used over budget', async () => {
  const { pruneCache, cacheSize, clearCache } = await import('./cacheFile.js');
  const o = opfsAdapter(null);
  const adapter = { fetchRange: async (_id, _i, s, e) => new Uint8Array(e - s + 1) };
  const day = 24 * 3600e3;
  const realNow = Date.now;
  try {
    for (const [id, age] of [['old', 10 * day], ['mid', 2 * day], ['new', 0]]) {
      Date.now = () => realNow() - age;
      await cachingFetchRange(o, adapter, id, 0)(0, 99); // 100 bytes each, used at now - age
    }
  } finally {
    Date.now = realNow;
  }
  assert.equal(await cacheSize(o), 300);
  // TTL 7 days drops 'old'; budget 150 then drops the LRU of the rest ('mid')
  const removed = await pruneCache(o, { maxBytes: 150 });
  assert.deepEqual(removed, ['old:0', 'mid:0']);
  assert.deepEqual(await o.listIds(), ['new:0']);
  await clearCache(o);
  assert.equal(await cacheSize(o), 0);
});

test('clearEverywhere clears local, in-browser and server; reports a server failure', async () => {
  const { clearEverywhere, describeClear } = await import('./clearEverywhere.js');
  const o = opfsAdapter(null);
  await o.write('a:0', 0, new Uint8Array(2048));
  const calls = [];
  const browser = { clearAll: async () => { calls.push('browser'); return 2; } };
  const server = { clearServerCache: async () => { calls.push('server'); return { removed: 3 }; } };
  // OPFS root: WebTorrent's piece dirs next to the cache dir
  const rootNames = new Set(['torwatch-cache', 'Some.Movie.2020', 'chunks']);
  const storageRoot = {
    async *keys() { yield* [...rootNames]; },
    async removeEntry(n, opts) { assert.equal(opts?.recursive, true); calls.push(`rm ${n}`); rootNames.delete(n); },
  };
  const r = await clearEverywhere({ opfs: o, server, browser, storageRoot, keepName: 'torwatch-cache' });
  assert.deepEqual(r, { localBytes: 2048, browserTorrents: 2, browserEntries: 2, serverTorrents: 3, serverError: null });
  assert.deepEqual([...rootNames], ['torwatch-cache'], 'cache dir kept, WebTorrent data gone');
  assert.deepEqual(calls, ['browser', 'rm Some.Movie.2020', 'rm chunks', 'server'], 'WebTorrent stopped before its files go');
  assert.deepEqual(await o.listIds(), []);
  const fmt = (n) => `${n} B`;
  assert.equal(describeClear(r, fmt), 'Cleared: local 2048 B, browser-engine data, 3 server torrent(s)');
  const down = { clearServerCache: async () => { throw new Error('request failed (401)'); } };
  const r2 = await clearEverywhere({ opfs: o, server: down, browser: null });
  assert.equal(r2.serverError, 'request failed (401)');
  assert.match(describeClear(r2, fmt), /server not cleared \(request failed \(401\)\)/);
});

test('pollMagnetReady stops with AbortError when its signal aborts', async () => {
  const ctl = new AbortController();
  let polls = 0;
  const adapter = { getMagnet: async () => { polls++; return { state: 'fetching-meta' }; } };
  const p = pollMagnetReady({ adapter, id: 'x', pollMs: 5, watchdogMs: 0, signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 20));
  ctl.abort();
  await assert.rejects(p, { name: 'AbortError' });
  const n = polls;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(polls, n, 'no polling after abort');
});

test('findMagnet returns the history magnet for an infohash', async () => {
  reset();
  const { findMagnet } = await import('./loadMagnet.js');
  const h = '0123456789abcdef0123456789abcdef01234567';
  store.ns('torwatch').set('history', [`magnet:?dn=x&xt=urn:btih:${h.toUpperCase()}&tr=udp://t`, 'magnet:?xt=urn:btih:ffff']);
  assert.equal(findMagnet(h), `magnet:?dn=x&xt=urn:btih:${h.toUpperCase()}&tr=udp://t`);
  assert.equal(findMagnet('deadbeef'), null);
});
