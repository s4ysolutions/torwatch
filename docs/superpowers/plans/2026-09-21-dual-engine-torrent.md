# Dual-engine torrent implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser torrent engine (vendored WebTorrent, default) next to the server engine, with one UX on both.

**Architecture:** New `webtorrentAdapter` implements the same surface as `backendAdapter` (extended with `attachNative` + `downloadFile`); `app.js` picks the engine from a persisted toggle; demux, players, subs, cache, poll loop unchanged.

**Tech Stack:** Vanilla ES modules in `static/`, WebTorrent v2 vendored UMD bundle, existing `node --test` suites, Go backend untouched.

**Spec:** `docs/superpowers/specs/2026-09-21-dual-engine-torrent-design.md`

## Global Constraints

- No server (Go) changes.
- No bundler; WebTorrent loads from `static/vendor/`, never from CDN.
- From the user point of view there are no differences between engines; no engine-specific UI strings.
- `getMagnet` returns only `fetching-meta` | `ready` | `error`; the `waiting` phase stays owned by the frontend watchdog.
- `fetchRange` bounds are inclusive on both ends; returns up to `end - start + 1` bytes — short/empty reads signal EOF per the `ByteStream` contract (`byteStream.js:70-78`), identical to the server path.
- Parity scoped to WebRTC-capable browsers; without `WEBRTC_SUPPORT` the app stays on the server engine.
- Toggle disabled while a torrent is active (phase not `idle`).
- `deleteMagnet` is surface parity only; no new UI button.
- Frontend tests run with `npm test` (node --test over `static/`); Go suite `go test ./...` must stay green.

---

### Task 1: Vendor WebTorrent + pin version

**Files:**
- Create: `static/vendor/webtorrent.min.js` (vendored UMD bundle, WebTorrent v2)
- Create: `static/vendor/VERSION` (exact resolved version, e.g. `2.9.0`)
- Create: `static/vendor/README.md` (source URL, license, how to re-vendor)
- Test: `static/adapters/vendor.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `window.WebTorrent` global (UMD) for Task 3/4; `VERSION` string consumed by the test.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

test('webtorrent vendor bundle is pinned and present', () => {
  const versionFile = path.join(here, '..', 'vendor', 'VERSION');
  const bundleFile = path.join(here, '..', 'vendor', 'webtorrent.min.js');
  assert.ok(existsSync(versionFile), 'static/vendor/VERSION missing');
  assert.ok(existsSync(bundleFile), 'static/vendor/webtorrent.min.js missing');
  const version = readFileSync(versionFile, 'utf8').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, 'VERSION must be exact x.y.z');
  const bundle = readFileSync(bundleFile, 'utf8');
  const firstLine = bundle.split('\n', 1)[0];
  assert.ok(firstLine.includes('webtorrent@' + version), 'bundle must carry pinned version header');
  assert.ok(bundle.length > 100000, 'bundle looks truncated');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test static/adapters/vendor.test.js`
Expected: FAIL (vendor files missing)

- [ ] **Step 3: Vendor the bundle**

Run (pin exact version; record it in VERSION — resolved 2.8.5, latest of the v2 line; bundle lives under `dist/`):
```bash
VER="2.8.5"
curl -fsSL "https://cdn.jsdelivr.net/npm/webtorrent@${VER}/dist/webtorrent.min.js" -o static/vendor/webtorrent.min.js
printf '/*! webtorrent@%s (MIT) vendored, see static/vendor/README.md */\n' "$VER" | cat - static/vendor/webtorrent.min.js > /tmp/wt.js && mv /tmp/wt.js static/vendor/webtorrent.min.js
printf '%s\n' "$VER" > static/vendor/VERSION
```
If that exact version 404s, resolve the newest v2 with `npm view webtorrent versions` (or the jsdelivr data API), use the resolved `x.y.z` in both commands, and record it. Then confirm the API names used in Tasks 3–4 exist in the bundle/docs: `client.add`, `client.get`, `client.remove`, `client.createServer`, `file.createReadStream({start,end})`, `file.streamTo`, `file.blob`,
`file.arrayBuffer`, `torrent.files`, `torrent.infoHash`,
`torrent.announce`, `WebTorrent.WEBRTC_SUPPORT`. Do NOT use
`file.getBlobURL`/`file.getBlob`/`file.getBuffer` — absent from v2.8.5
(verified against the bundle). If any other name differs, update Tasks 3–4 before implementing them. Write `static/vendor/README.md` with source URL, version, license (MIT), and the re-vendor commands.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test static/adapters/vendor.test.js`
Expected: PASS; also run full suite `npm test`, Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add static/vendor/ static/adapters/vendor.test.js
git commit -m "feat: vendor webtorrent bundle pinned"
```

---

### Task 2: Uniform adapter surface on `backendAdapter`

**Files:**
- Modify: `static/adapters/backendAdapter.js` (add `attachNative`, `downloadFile`)
- Test: `static/adapters/adapters.test.js` (extend; do not rewrite existing cases)

**Interfaces:**
- Consumes: nothing new.
- Produces (both adapters implement these; exact signatures):
  - `attachNative(id, index, videoEl) -> Promise<() => void>` — attaches playback, resolves a cleanup that detaches it.
  - `downloadFile(id, index) -> Promise<{name: string, url?: string, blob?: Blob}>` — exactly one of `url` or `blob` is set.

- [ ] **Step 1: Write the failing test**

```js
// append to static/adapters/adapters.test.js
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
```

(`downloadFile` name: server cannot know the filename without metadata; use `getMagnet` result when available, else fall back to `file-2`. Implement: try `getMagnet(id)` → find file index → basename of `path`; catch → `file-${index}`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test static/adapters/adapters.test.js`
Expected: FAIL (`attachNative is not a function`)

- [ ] **Step 3: Write minimal implementation**

```js
// inside backendAdapter(fetchImpl = fetch), add to returned object:
async attachNative(id, index, videoEl) {
  videoEl.src = `/api/magnets/${id}/files/${index}`;
  return () => {
    try { videoEl.removeAttribute('src'); videoEl.load(); } catch {}
  };
},
async downloadFile(id, index) {
  let name = `file-${index}`;
  try {
    const info = await this.getMagnet(id);
    const f = (info.files ?? []).find(x => x.index === index);
    if (f?.path) name = String(f.path).split('/').pop() || name;
  } catch {}
  return { name, url: `/api/magnets/${id}/files/${index}` };
},
```

(`this` refers to the returned adapter object; keep object-method shorthand so `this.getMagnet` works.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test static/adapters/adapters.test.js` then `npm test`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add static/adapters/backendAdapter.js static/adapters/adapters.test.js
git commit -m "feat: uniform attachNative/downloadFile on backend adapter"
```

---

### Task 3: `webtorrentAdapter` metadata + trackers + state mapping

**Files:**
- Create: `static/adapters/webtorrentAdapter.js`
- Test: `static/adapters/webtorrentAdapter.test.js`

**Interfaces:**
- Consumes: `window.WebTorrent` (real) or injected `clientFactory` (tests); injected `searchSubs` fn.
- Produces:
  - `webtorrentAdapter({ clientFactory, searchSubs, announceList }) -> adapter`
  - `addMagnet(magnet) -> Promise<{id}>`, `addTorrentFile(arrayBuffer|Uint8Array) -> Promise<{id}>` (ids lowercased; see Task 6 `normId` — adapters additionally lowercase ids on entry so the shared OPFS key `${id}:${index}` matches across engines: WebTorrent infoHash is lowercase hex, anacrolix `HexString()` is uppercase)
  - `getMagnet(id) -> Promise<{id, name, state, error?, files: [{index, path, size}]}>`; `state` ∈ `fetching-meta|ready|error`; `files` is `[]` until `ready`; `error` is set only in `error` state (consumed by `pollMagnetReady` in `loadMagnet.js`).
  - `deleteMagnet(id) -> Promise<void>` (calls `client.remove(id, {destroyStore: true})`; unknown id resolves silently).

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test static/adapters/webtorrentAdapter.test.js`
Expected: FAIL (`webtorrentAdapter.js` missing)

- [ ] **Step 3: Write minimal implementation**

```js
export const PINNED_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.fastcast.nz',
];

function mapFiles(torrent) {
  return (torrent.files ?? []).map((f, i) => ({
    index: i,
    path: f.path ?? f.name ?? `file-${i}`,
    size: f.length ?? f.size ?? 0,
  }));
}

export function webtorrentAdapter({ clientFactory, searchSubs, announceList = PINNED_TRACKERS } = {}) {
  let client = null;
  const errors = new Map(); // id -> message
  const ensureClient = () => {
    if (!client) {
      client = typeof clientFactory === 'function'
        ? clientFactory()
        : new globalThis.WebTorrent();
    }
    return client;
  };
  const withTorrent = (id) => ensureClient().get(id);
  return {
    async addMagnet(magnet) {
      const c = ensureClient();
      const t = c.add(magnet, { announce: [...announceList] });
      const id = t.infoHash;
      t.on('error', (e) => errors.set(id, e?.message ?? String(e)));
      return { id };
    },
    async addTorrentFile(data) {
      const c = ensureClient();
      const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
      const t = c.add(buf, { announce: [...announceList] });
      const id = t.infoHash;
      t.on('error', (e) => errors.set(id, e?.message ?? String(e)));
      return { id };
    },
    async getMagnet(id) {
      const t = withTorrent(id);
      if (!t) throw new Error('unknown magnet ' + id);
      if (errors.has(id)) return { id, name: t.name ?? '', state: 'error', error: errors.get(id), files: [] };
      if (t.ready || (t.files ?? []).length) {
        return { id, name: t.name ?? '', state: 'ready', files: mapFiles(t) };
      }
      return { id, name: t.name ?? '', state: 'fetching-meta', files: [] };
    },
    async deleteMagnet(id) {
      try { ensureClient().remove(id, { destroyStore: true }); } catch {}
    },
    searchSubs: typeof searchSubs === 'function' ? searchSubs : async () => { throw new Error('search not configured'); },
    // fetchRange / attachNative / downloadFile arrive in Task 4.
  };
}
```

Notes: `client.add` is sync and returns the torrent; metadata readiness is observed via `getMagnet` polling (same poll loop as server). `announce` is always injected for both magnets and `.torrent` buffers — a magnet's tracker list is empty until metadata arrives so conditional injection is undecidable pre-add, and `client.add` merges `opts.announce` with embedded lists. Ids are lowercased on entry in every method (`const norm = (s) => String(s).toLowerCase()`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test static/adapters/webtorrentAdapter.test.js` then `npm test`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add static/adapters/webtorrentAdapter.js static/adapters/webtorrentAdapter.test.js
git commit -m "feat: webtorrent adapter metadata and trackers"
```

---

### Task 4: `webtorrentAdapter` bytes — fetchRange, attachNative, downloadFile

**Files:**
- Modify: `static/adapters/webtorrentAdapter.js`
- Modify: `static/adapters/webtorrentAdapter.test.js` (append)

**Interfaces:**
- Consumes: Task 3 adapter object.
- Produces:
  - `fetchRange(id, index, start, end) -> Promise<Uint8Array>` (inclusive; up to `end - start + 1` bytes, short reads signal EOF)
  - `attachNative(id, index, videoEl) -> Promise<() => void>` (via `file.streamTo(videoEl)` after one `client.createServer()`; cleanup pauses + removes src)
  - `downloadFile(id, index) -> Promise<{name, blob}>` (via `file.blob()` fallback `file.arrayBuffer`)

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { webtorrentAdapter } from './webtorrentAdapter.js';
import { MkvDemuxer } from '../demux/mkvDemuxer.js';
// (fakeTorrent/fakeClient helpers live in this file from Task 3; reuse them.)

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
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  client.get(id).files = [{
    name: 'm.mkv', path: 'm.mkv', length: 100,
    createReadStream({ start, end }) {
      // emulate EOF clamping like a real torrent stream
      return Readable.from([bytes.slice(start, Math.min(end, 99) + 1)]);
    },
  }];
  const out = await a.fetchRange(id, 0, 90, 199);
  assert.equal(out.length, 10);
  assert.deepEqual([...out], [...bytes.slice(90, 100)]);
});
```

```js
test('attachNative uses streamTo and cleanup detaches', async () => {
  const client = fakeClient();
  client.createServer = () => {};
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
});

test('downloadFile returns blob variant with filename', async () => {
  const client = fakeClient();
  const a = webtorrentAdapter({ clientFactory: () => client, searchSubs: async () => ({}) });
  const { id } = await a.addMagnet('magnet:?xt=urn:btih:' + 'ab'.repeat(20));
  client.get(id).files = [{ name: 'm.mkv', path: 'dir/m.mkv', length: 5,
    blob(cb) { cb(new Blob(['hello'])); } }];
  const dl = await a.downloadFile(id, 0);
  assert.equal(dl.name, 'm.mkv');
  assert.ok(dl.blob instanceof Blob);
  assert.equal(dl.url, undefined);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test static/adapters/webtorrentAdapter.test.js`
Expected: FAIL (`fetchRange is not a function`)

- [ ] **Step 3: Write minimal implementation**

```js
// add inside the returned object of webtorrentAdapter (Task 3):
async fetchRange(id, index, start, end) {
  const t = withTorrent(id);
  if (!t) throw new Error('unknown magnet ' + id);
  const f = (t.files ?? [])[index];
  if (!f) throw new Error('bad file index ' + index);
  const stream = f.createReadStream({ start, end });
  const chunks = [];
  for await (const c of stream) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  // No length enforcement: short/empty reads signal EOF (ByteStream
  // contract, same as the server path). Callers must tolerate them.
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
},
async attachNative(id, index, videoEl) {
  const c = ensureClient();
  let serverOk = true;
  if (typeof c.createServer === 'function' && !c._twServer) {
    try { c._twServer = c.createServer(); } catch { serverOk = false; }
  }
  if (!serverOk) throw new Error('native playback unavailable (stream server failed)');
  const t = withTorrent(id);
  const f = (t?.files ?? [])[index];
  if (!f || typeof f.streamTo !== 'function') throw new Error('native playback unavailable');
  f.streamTo(videoEl);
  return () => {
    try { videoEl.pause(); } catch {}
    try { videoEl.removeAttribute('src'); videoEl.load(); } catch {}
  };
},
async downloadFile(id, index) {
  const t = withTorrent(id);
  const f = (t?.files ?? [])[index];
  if (!f) throw new Error('bad file index ' + index);
  const name = String(f.path ?? f.name ?? `file-${index}`).split('/').pop();
  const blob = await new Promise((resolve, reject) => {
    try {
      if (typeof f.blob === 'function') return f.blob((b) => b ? resolve(b) : reject(new Error('blob failed')));
      if (typeof f.arrayBuffer === 'function') {
        return f.arrayBuffer((ab) => {
          try { resolve(new Blob([ab])); } catch (e) { reject(e); }
        });
      }
      reject(new Error('download unavailable'));
    } catch (e) { reject(e); }
  });
  return { name, blob };
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test static/adapters/webtorrentAdapter.test.js` then `npm test`
Expected: PASS both (including the `MkvDemuxer` reuse test proving embedded subtitle extraction over adapter bytes).

- [ ] **Step 5: Commit**

```bash
git add static/adapters/webtorrentAdapter.js static/adapters/webtorrentAdapter.test.js
git commit -m "feat: webtorrent byte range, native attach, download"
```

---

### Task 5: Service worker for `streamTo`

**Files:**
- Create: `static/sw.js` (minimal; WebTorrent `createServer` requirement)
- Test: `static/adapters/vendor.test.js` (append presence assertion) — or a new `static/sw.test.js`; prefer appending to `vendor.test.js` to keep vendor checks together.

**Interfaces:**
- Consumes: vendored bundle docs (Task 1 confirmation).
- Produces: `/sw.js` served by the existing static file server; registration call site in Task 6.

- [ ] **Step 1: Write the failing test**

```js
test('service worker file exists for webtorrent server', () => {
  const sw = path.join(here, '..', 'sw.js');
  assert.ok(existsSync(sw), 'static/sw.js missing');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test static/adapters/vendor.test.js`
Expected: FAIL (`static/sw.js missing`)

- [ ] **Step 3: Write minimal implementation**

`static/sw.js`: copy the service worker snippet shipped with the pinned WebTorrent version's docs (it intercepts the `createServer` stream URLs). Keep it verbatim from upstream with a header comment stating version + source. No app logic in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test static/adapters/vendor.test.js` then `npm test`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add static/sw.js static/adapters/vendor.test.js
git commit -m "feat: service worker for webtorrent streamTo"
```

---

### Task 6: app + input card wiring (engine toggle, uniform native/downloads)

**Files:**
- Modify: `static/app.js` (both `backendAdapter()` sites: module top ~line 48 and `DOMContentLoaded` ~line 399 become `buildAdapter(getEngine())`)
- Modify: `static/views/inputCardView.js`
- Modify: `static/player/nativePlayer.js` (accept attach fn)
- Modify: `static/views/downloadsRow.js` (`videoName` support)
- Test: `static/views/views.test.js` (toggle renders defaulting to browser; downloadsRow uses videoName) — extend, do not rewrite.

**Interfaces:**
- Consumes: `backendAdapter`, `webtorrentAdapter`, engine store key `engine` (`browser` default).
- Produces: same routes and phases; native path via `adapter.attachNative`; downloads via `adapter.downloadFile`; toggle disabled unless phase is `idle`.

- [ ] **Step 1: Write the failing tests**

```js
// views.test.js additions. NOTE: the existing makeStubEl drops attributes
// (setAttribute is a noop) and has no querySelector. First extend it:
//   setAttribute(k, v) { (this.attrs ??= {})[k] = v; },
// then walk children instead of querySelector.

import { inputCardView } from './inputCardView.js';
import { downloadsRow } from './downloadsRow.js';

function walk(n) { return [n, ...(n.children ?? []).flatMap(walk)]; }

test('input card shows engine toggle defaulting to browser', () => {
  const restore = installStub();
  try {
    const host = globalThis.document.createElement('div');
    inputCardView(host, { onMagnet() {}, onTorrentFile() {}, onSubsFile() {}, onEngine() {} });
    const radios = walk(host).filter(n => n.tagName === 'INPUT' && n.attrs?.name === 'engine');
    assert.equal(radios.length, 2);
    const values = radios.map(r => r.attrs.value).sort();
    assert.deepEqual(values, ['browser', 'server']);
    const checked = radios.filter(r => 'checked' in (r.attrs ?? {}));
    assert.equal(checked.length, 1);
    assert.equal(checked[0].attrs.value, 'browser');
  } finally { restore(); }
});

test('downloadsRow uses videoName for the download attribute', () => {
  const restore = installStub();
  try {
    const row = downloadsRow(() => ({ videoUrl: 'blob:x', videoName: 'm.mkv' }));
    const a = walk(row).find(n => n.tagName === 'A');
    assert.ok(a, 'video link missing');
    assert.equal(a.attrs.download, 'm.mkv');
  } finally { restore(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test static/views/views.test.js`
Expected: FAIL (toggle missing)

- [ ] **Step 3: Write minimal implementation**

1. `static/player/nativePlayer.js` (disposed flag closes the attach race; `ready` stays rejected on attach failure so the caller can surface it):
```js
export function createNativePlayer(videoEl, attach) {
  let cleanup = null;
  let disposed = false;
  const ready = Promise.resolve()
    .then(() => {
      if (disposed) return null;
      return attach(videoEl);
    })
    .then((c) => {
      if (disposed) {
        try { if (typeof c === 'function') c(); } catch {}
        return null;
      }
      cleanup = c;
      return null;
    });
  return {
    ready,
    play: () => videoEl.play(),
    pause: () => videoEl.pause(),
    seek: (s) => { videoEl.currentTime = s; },
    dispose: () => {
      disposed = true;
      try { videoEl.pause(); } catch {}
      ready.then(() => {
        try { if (typeof cleanup === 'function') cleanup(); } catch {}
      }).catch(() => {});
      try { videoEl.removeAttribute('src'); videoEl.load(); } catch {}
    },
  };
}
```
Callers pass `attach = (el) => adapter.attachNative(id, fileIndex, el)` — no URLs in app code. After creating a native player, app code surfaces attach failures: `if (player.ready?.catch) player.ready.catch((e) => { if (!cancelled) fail(e); });`

2. `static/app.js`:
   - Engine store + id normalization (single choke point; WebTorrent infoHash is lowercase hex, anacrolix `HexString()` uppercase — lowercase everywhere so the OPFS key `${id}:${index}` and routes match across engines):
```js
const engineStore = store.ns('torwatch');
const getEngine = () => engineStore.get('engine', 'browser');
const normId = (s) => String(s).toLowerCase();
```
   - Capability check runs *before* selecting the engine (client creation is lazy, so try/catch around the factory cannot catch it):
```js
function canUseBrowserEngine() {
  try {
    const WT = globalThis.WebTorrent;
    return typeof WT !== 'undefined' && WT.WEBRTC_SUPPORT !== false;
  } catch { return false; }
}
function buildAdapter(engine) {
  if (engine === 'server' || !canUseBrowserEngine()) return backendAdapter();
  if (!buildAdapter._server) buildAdapter._server = backendAdapter();
  const server = buildAdapter._server;
  return webtorrentAdapter({ searchSubs: (q) => server.searchSubs(q) });
}
```
   Replace both `backendAdapter()` sites (module top ~line 48, `DOMContentLoaded` ~line 399) with `buildAdapter(getEngine())`. Lowercase every adapter-returned id (`submitMagnet`, `submitTorrent`) and every route-param id (`mountPlay`) via `normId`.
   - Native branch becomes `player = createNativePlayer(video, (el) => adapter.attachNative(id, fileIndex, el))` plus the `player.ready.catch(fail)` surfacing from item 1.
   - `renderDl` becomes generation-guarded async (browser `file.blob()` is slow; without the guard an in-flight call resolves after teardown into a cleared host or leaks a blob URL):
```js
let dlGen = 0;
const renderDl = async () => {
  const gen = ++dlGen;
  const stillCurrent = () => !cancelled && gen === dlGen;
  // ... existing srt-blob block unchanged (synchronous) ...
  let videoHref = null, videoName = 'video';
  try {
    const dl = await adapter.downloadFile(id, fileIndex);
    if (!stillCurrent()) { if (dl.blob) URL.revokeObjectURL(URL.createObjectURL(dl.blob)); return; }
    videoName = dl.name || videoName;
    videoHref = dl.url ?? URL.createObjectURL(dl.blob);
    if (!dl.url) videoBlobUrls.push(videoHref);
  } catch { if (!stillCurrent()) return; }
  if (!stillCurrent()) return;
  dlDispose = downloadsRow(dlHost, () => ({ videoUrl: videoHref, videoName, srtUrl: srtLink, srtLabel }));
};
```
   Track browser-engine blob URLs in `videoBlobUrls = []`; revoke all on re-render (bump `dlGen` first) and on teardown. Teardown does `dlGen++` so late resolves no-op.
   - `showFileLinks` (unplayable fallback, home): same discipline — per-file `await adapter.downloadFile(info.id, f.index)` in an async loop guarded by a home-level `cancelled` flag; collect created blob URLs in `fileLinkUrls` and revoke them in `mountHome`'s teardown (`clear(host)` alone cannot revoke).
   - `static/views/downloadsRow.js`: accept and render `videoName`:
```js
const { videoUrl = null, videoName = 'video', srtUrl = null, srtLabel = '.srt' } =
  (typeof getUrls === 'function' ? getUrls() : {}) ?? {};
if (videoUrl) links.push(el('a', { href: videoUrl, download: videoName || 'video' }, ['⬇ video']));
```
   (`el()` renders a string `download` as `download="name"`; the old `download: true` rendered `download=""`, which saves blob URLs under a random UUID.) Update the header comment: `getUrls() => { videoUrl?, videoName?, srtUrl?, srtLabel? }`.

3. `static/views/inputCardView.js` (exact code; props gain optional `onEngine`):
```js
const { onMagnet, onTorrentFile, onSubsFile, onEngine } = props;
// ... existing inputs ...
const engines = [['browser', 'Browser (default)'], ['server', 'Server']];
const currentEngine = store.ns('torwatch').get('engine', 'browser');
const engineRow = el('div', { class: 'engine-toggle' }, engines.map(([v, label]) =>
  el('label', {}, [
    el('input', { type: 'radio', name: 'engine', value: v, ...(currentEngine === v ? { checked: true } : {}) }),
    label,
  ]),
));
```
Insert `engineRow` into the card section. Wire + dispose (real DOM has `querySelectorAll`; the stub test walks children instead):
```js
const onEngineChange = (e) => {
  const v = e?.target?.value;
  if ((v === 'browser' || v === 'server') && typeof onEngine === 'function') onEngine(v);
};
const engineRadios = [...engineRow.querySelectorAll('input[name="engine"]')];
for (const r of engineRadios) r.addEventListener('change', onEngineChange);
// in dispose(), alongside existing removeEventListener calls:
for (const r of engineRadios) r.removeEventListener('change', onEngineChange);
```
`app.js mountHome` passes `onEngine: (v) => { engineStore.set('engine', v); adapter = buildAdapter(v); }`. Toggle invariant (comment in `mountHome`): the toggle lives only on the home card, and home mounts only at phase `idle` — so there is deliberately no mid-play engine switch to handle.

4. Register `/sw.js`: check registration, not `.controller` (`.controller` stays null until the worker controls the page, which needs a reload — so registration alone never flips it):
```js
async function ensureSw() {
  try {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) await navigator.serviceWorker.register('/sw.js');
    return true;
  } catch { return false; }
}
```
Call `void ensureSw()` once at boot in `DOMContentLoaded` (not per-play). Comment at the call site: `streamTo` needs the worker controlling the page, so the very first browser-engine native play after first install may need one reload — covered by a Task 7 manual step.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test static/views/views.test.js` then `npm test` then `go test ./...`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add static/app.js static/views/inputCardView.js static/views/downloadsRow.js static/player/nativePlayer.js static/views/views.test.js
git commit -m "feat: engine toggle with uniform native and downloads"
```

---

### Task 7: Manual verification matrix (both engines)

No code. Run the manual checklist per engine and record results in the commit message or a note.

- [ ] **Step 1:** Browser engine: MP4 magnet → native plays; upload `.srt` → cues render.
- [ ] **Step 2:** Browser engine: MKV (2 audio + embedded subs) → MSE plays; audio switch works; embedded subs list + active cue highlight + copy.
- [ ] **Step 3:** Browser engine: reload mid-play → OPFS hit, position restored.
- [ ] **Step 4:** Browser engine: no-peer magnet → `waiting` after 60s, poll continues.
- [ ] **Step 5:** Repeat Steps 1–4 on server engine (where P2P works); results identical.
- [ ] **Step 6:** Offline-vendor check: block CDN hosts, reload page, browser engine still plays.
- [ ] **Step 7:** Toggle invariant: open a play route directly — no engine toggle is rendered there (it lives only on the home card at `idle`).
- [ ] **Step 8:** First-install service worker: on a fresh profile, first browser-engine native play may need one reload before `streamTo` works (worker must control the page); verify play succeeds after reload.
- [ ] **Step 9:** `npm test` + `go test ./...` green. Commit the record:

```bash
git commit --allow-empty -m "verify: dual-engine manual matrix green"
```

---

## Self-review (after code-review fixes)

- Spec coverage: toggle + default (§Architecture) → Task 6 (toggle lives only on the home card at `idle`, recorded as the no-mid-play-switch invariant); vendored + VERSION (§Components) → Task 1; tracker injection → Task 3 (always-inject for magnets and buffers; spec updated to match); `fetchRange`/`subtitleCues` reuse (§Data flow) → Task 4 including the `MkvDemuxer`-over-`fetchRange` reuse test; `attachNative`/`downloadFile` (§Data flow 5–6) → Tasks 2, 4, 6 (incl. `videoName` in downloadsRow); `sw.js` (§Components) → Task 5 + boot registration in Task 6; state set + shared OPFS key + destroyStore (§Errors/Data) → Tasks 3, 4 (destroyStore test included); `searchSubs` delegation → Task 6 (single shared server instance); WEBRTC_SUPPORT fallback → Task 6 capability check; testing § → Tasks 1–5 unit + Task 7 manual (toggle-absent + SW-reload checks included).
- Placeholders: none — every step has exact code/commands; version resolution is a concrete command, not a TBD.
- Type consistency: `attachNative(id, index, videoEl) -> Promise<cleanup>` and `downloadFile(id, index) -> Promise<{name, url?, blob?}>` spelled identically in Tasks 2, 4, 6; `getMagnet` shape `{id, name, state, error?, files:[{index,path,size}]}` identical in Tasks 3–4; OPFS key `${id}:${index}` unchanged everywhere; ids lowercased at the app choke point (Task 6 `normId`) plus adapter entry points (Task 3).
