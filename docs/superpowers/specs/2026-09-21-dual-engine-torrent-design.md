# Dual-engine torrent design (browser default, server variant)

Date: 2026-09-21. Status: approved design, not yet planned or implemented.

## Problem

Server-side torrent client (`torwatch/internal/torrents`, anacrolix) returns
empty metadata on Oracle Cloud on every magnet. Symptom: `Info` stays
`fetching-meta` with empty `files`, frontend watchdog flips to `waiting`
after 60s and never reaches `ready`. Suspected cause: Oracle filters P2P
(DHT / tracker UDP). Server code stays for hosts where P2P works.

## Goal

Two engines, one UX. Manual toggle, browser engine default. From the user
point of view there are no differences: magnet + .torrent input, progress,
native + MKV/MSE playback, audio switch, embedded + external subs, OPFS
cache, position restore, download links.

Parity is scoped to WebRTC-capable browsers. If
`WebTorrent.WEBRTC_SUPPORT` is false at boot, the app stays on the server
engine (or shows a note) rather than pretending the browser engine works.

## Approach: adapter swap (approved)

New `webtorrentAdapter` implements the same surface as `backendAdapter`.
`app.js` picks the active adapter from the toggle. Demux, players, subs
widget, cache, and poll loop stay unchanged.

## Architecture and components

- Engine store: `store.ns('torwatch')` key `engine`, `browser` | `server`,
  default `browser`, persisted. The toggle lives only on the home card,
  and home mounts only at phase `idle` — so there is deliberately no
  mid-play engine switch to handle.
- `static/app.js`: adapter factory from engine; native-attach and download
  wiring via the adapter (see below). No hardcoded `/api/magnets/...` URLs
  remain in app code — every URL site routes through the adapter.
- `static/views/inputCardView.js`: toggle UI only (two radios). No fetch
  logic. Callbacks unchanged.
- New `static/adapters/webtorrentAdapter.js`: owns one WebTorrent client
  and per-id torrent handles. Surface (superset, matching backend):
  - `addMagnet(magnet) -> {id}` (id = infohash hex)
  - `addTorrentFile(buf) -> {id}`
  - `getMagnet(id) -> {state, name, files}` — `state` is only
    `fetching-meta` | `ready` | `error` (same set as
    `torrents.MagnetInfo.State`). The `waiting` UI phase stays owned by the
    frontend watchdog, never returned here.
  - `fetchRange(id, index, start, end) -> Uint8Array` (inclusive bounds)
  - `deleteMagnet(id)` (surface parity; no UI caller yet — see Non-goals)
  - `searchSubs(q)` — delegates to the injected backend `searchSubs`
    (OpenSubtitles proxy stays server-side)
  - `attachNative(id, index, videoEl) -> Promise<cleanup>` — browser calls
    `file.streamTo(videoEl)` (after `client.createServer()` + service
    worker); server sets `videoEl.src` to the range URL.
  - `downloadFile(id, index) -> Promise<{name, blob}>` — browser uses
    `file.blob()` (or `file.arrayBuffer` + `new Blob`) with `file.name`;
    server returns `{name, url}` (range URL), since a plain `<a download>`
    href is fine on the server path.
- New `static/vendor/webtorrent.min.js` + `static/vendor/VERSION`: vendored
  and pinned, loads offline with no CDN.
- New service worker file under `static/` (e.g. `static/sw.js`, minimal)
  required by WebTorrent `client.createServer()` for `streamTo`. Registered
  only when a browser-engine native play needs it.
- Tracker injection: public `wss` trackers always injected for magnets via
  `client.add(magnet, {announce})` and for `.torrent` buffers alike — a magnet's
  tracker list is empty until metadata arrives so conditional injection is
  undecidable pre-add, and `client.add` merges `opts.announce` with embedded
  lists.
- Unchanged: `static/usecases/loadMagnet.js` poll contract,
  `static/usecases/cacheFile.js` read-through cache,
  `static/demux/mkvDemuxer.js` header + `subtitleCues`, players, subs
  widget, server code.

## Data flow

1. Submit -> `adapter.addMagnet(magnet)` returns `{id}` with id = infohash
   hex. `.torrent` file -> `adapter.addTorrentFile(buf)`; its id matches
   the backend's `HashInfoBytes().HexString()` so the shared OPFS key holds.
2. `pollMagnetReady` polls `adapter.getMagnet(id)` until `ready`. Watchdog
   60s -> `waiting` phase, poll unbounded. `pickVideoFile` picks largest
   `.mp4`/`.mkv`/`.webm`.
3. Play mount: `fetchRange = cachingFetchRange(opfs, adapter, id, index)`.
   MKV -> `MkvDemuxer(fetchRange).readHeader()` + `subtitleCues()` for
   embedded subs. MP4/WebM -> native path.
4. Browser adapter mapping: WebTorrent `metadata` event -> `ready` with
   `files [{index, path, size}]` where `size = file.length`,
   `path = file.path ?? file.name`, index = position in `torrent.files`;
   client/torrent `error` -> `error` state; `fetchRange(start, end)` opens
   one read stream per cache miss and concats chunks (inclusive bounds).
   OPFS key `${id}:${index}` is shared across engines.
5. Native playback: `createNativePlayer` is refactored to take an attach
   function (not a URL): server sets `src` to the range URL; browser calls
   `adapter.attachNative` which does `file.streamTo(videoEl)`. Seek, pause,
   dispose semantics unchanged (dispose calls the returned cleanup).
6. Downloads row uses `adapter.downloadFile(id, index)`: a materialized
   blob on the browser engine, a plain range URL on the server engine. The
   play URL is never reused for downloads (MediaSource streams do not
   reliably complete as `<a download>` and are revoked on teardown).

## Errors and cleanup

- Same visible states on both engines: bad input -> `error`; no metadata
  or peers -> `waiting` ("Waiting for peers…"), unbounded poll; read or
  mux failure -> player `error`. No engine-specific strings.
- Browser-internal "no WebRTC peers yet" is simply the absence of a
  `metadata` event -> `getMagnet` keeps returning `fetching-meta`, and the
  existing watchdog owns the `waiting` phase.
- Two distinct stores, kept explicit:
  - WebTorrent's own idb-chunk-store (default, browser persistence) is kept
    on play teardown so re-entry is fast.
  - torwatch's OPFS read-through cache (`cacheFile.js`) is untouched and
    shared across engines via the `${id}:${index}` key.
  - `deleteMagnet` calls `client.remove(id, {destroyStore: true})`; play
    teardown removes the handle but keeps both stores.
- Cleanup: `attachNative`'s returned cleanup stops `streamTo` on play
  teardown; service worker stays registered (tiny, reused).
- `searchSubs` always uses the server proxy on both engines.

## Testing

- Unit (`node --test`, no network, fake WebTorrent client): tracker
  injection (always for magnets, conditional for `.torrent`); state mapping
  fetching-meta/ready/error (assert `waiting` is never returned);
  `fetchRange` inclusive bounds returns exactly `end - start + 1` bytes;
  `destroyStore` on delete; `attachNative`/`downloadFile` calls; one reuse
  test with `MkvDemuxer` over adapter bytes proving embedded subtitle
  extraction on browser bytes.
- Existing demux, player, views, adapter, usecase suites stay green.
- Vendored check: block CDN hosts, page and playback still work.
- Manual per engine (browser + server): MP4 native with subs upload; MKV
  MSE with audio switch and embedded subs; reload OPFS hit with position;
  stalled torrent shows waiting; duplicate magnet reuse; toggle disabled
  mid-play.

## Open points for the plan

- Exact vendored WebTorrent build/version to be pinned (recorded in
  `static/vendor/VERSION`).
- Public `wss` tracker list to be pinned in the adapter with a comment.
- Service worker registration scope and whether it is registered lazily
  (first browser-engine native play) vs at boot — decided at plan time.

## Non-goals

- No server changes. No bridge or hybrid seeding. No bundler. No new
  player or demuxer. No engine-specific UI strings. No new `deleteMagnet`
  UI button (the method stays for surface parity; wiring a delete action is
  out of scope).
