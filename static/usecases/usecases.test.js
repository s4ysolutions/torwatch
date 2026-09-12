import test from 'node:test';
import assert from 'node:assert/strict';
import { backendAdapter } from '../adapters/backendAdapter.js';
import { opfsAdapter } from '../adapters/opfsAdapter.js';
import { store } from '../util/store.js';
import { playerState } from '../domain/playerState.js';
import { tracks } from '../domain/tracks.js';
import { loadMagnet, savePosition, loadPosition, bindPosition } from './loadMagnet.js';
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
  playerState.set({ phase: 'idle', magnetId: null, fileIndex: 0, position: 0, duration: 0, error: null });
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
