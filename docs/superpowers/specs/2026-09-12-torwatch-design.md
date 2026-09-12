# torwatch — design spec

Date: 2026-09-12
Status: approved (sections reviewed in chat)

## Summary

Web app that plays torrent videos from magnet links or uploaded `.torrent` files,
with in-browser audio-track switching and subtitles. UI clones the look and feel of
`~/s4y/youtubesubtitles-web`. Frontend is plain JS with event-based reactivity
(pattern from `~/s4y/meridian/meridian/features/frontend-plain`). Backend is a
single Go binary. Target host: Oracle Cloud ARM VPS, 1–4 GB RAM — the browser does
as much work as possible.

## Decisions (from brainstorming)

1. **Audio tracks**: embedded in the container, switched best-effort via in-browser
   demux + MSE. No server-side transcode. Unsupported codecs → clear error + raw
   file download.
2. **Subtitles**: primary source = embedded in the torrent (extracted in browser).
   Additional options: external `.srt`/`.vtt` upload, OpenSubtitles API search
   (optional, needs API key), manual paste/URL.
3. **Torrent engine**: hybrid — try WebTorrent (WebRTC peers) in browser first,
   fall back to Go backend (anacrolix/torrent) streaming over HTTP range requests.
4. **Scope extras**: localStorage remembers playback position + magnet history;
   server keeps torrents/files for a configured TTL (like yt-subtitles jobs),
   with disk-budget cleanup.

## Architecture

```
┌─ Browser (pure JS, ES modules) ─────────────────┐
│  magnet → try WebTorrent (WebRTC peers)         │
│     ├─ works → stream via webtorrent            │
│     └─ stalls/fails → fallback to Go backend    │
│         fetch file bytes via HTTP range          │
│  mkv/mp4 demux → MSE: video + selectable audio   │
│  subtitle streams extracted → VTT cues           │
│  Subtitles widget: synced cue list, click-to-seek│
│  OPFS file cache: survives page reload           │
│  localStorage: playback position, magnet history │
└──────────────────────────────────────────────────┘
        │ fallback only
┌─ Go backend (VPS, 1 binary) ────────────────────┐
│  anacrolix/torrent: magnet → file set →          │
│    stream pieces on demand (HTTP range)          │
│  Retention: TTL (default 24h) + disk budget,     │
│    cron cleanup                                  │
│  OpenSubtitles proxy (optional)                  │
│  Serves static frontend                          │
└──────────────────────────────────────────────────┘
```

### MKV playback

Browser `<video>` cannot play MKV natively. When the MKV contains
MSE-compatible codecs (h264/h265 video + aac/mp3/opus audio), it is remuxed to
fMP4 in the browser, incrementally, while streaming — playback starts after the
first clusters; no full download. H264 in MKV is often Annex-B in blocks; the
demuxer converts to AVCC on the fly. Seek = fetch a different byte range, reset
SourceBuffer, resume. Unsupported layouts (ordered chapters, header-stripped
codecs, non-MSE codecs) → clear error message + offer raw file download.

### OPFS local cache

Chunks are written to an OPFS (Origin Private File System) file as they arrive
(from either source). On page reload the partial or complete file is remounted
into the player instantly. Also prevents duplicate VPS bandwidth: backend bytes
are fetched once. Fallback for browsers without OPFS: IndexedDB blobs, or silent
re-download. Not available in private browsing. Uses
`navigator.storage.persist()` where granted; a client-side TTL purges old cache
entries.

## Frontend structure

```
static/
  index.html          tokens + layout, yt-subtitles look (card, status bar, stage)
  app.js              boot, emitter wiring
  util/      dom.js (el), events.js (emitter), store.js (localStorage)
  domain/    route.js, playerState.js (emitters), tracks.js (audio/subs model)
  usecases/  loadMagnet.js, pickSource.js (webtorrent→fallback), seek.js,
             cacheFile.js (OPFS write/read), switchAudio.js, loadSubtitles.js
  adapters/  webtorrentAdapter.js, backendAdapter.js (HTTP range),
             subtitlesAdapter.js (upload/opensubtitles/paste), opfsAdapter.js
  demux/     ebml.js, mkvDemuxer.js, mp4Demuxer.js (mp4box.js vendored),
             fmp4Muxer.js (→ MSE)
  player/    msePlayer.js, nativePlayer.js (mp4 fallback, plain <video>+src)
  views/     inputCardView.js, statusBar.js, videoStageView.js,
             subtitlesWidget.js, tracksMenu.js, downloadsRow.js
```

Conventions (from meridian frontend-plain):

- State lives in emitters (`x.subscribe(...)`), never in the DOM.
- Views have shape `render(container) => disposeFn`.
- Adapters own all I/O (network, OPFS, localStorage, WebTorrent).
- demux/ is pure code — no DOM, unit-testable in node.

### Subtitles widget

Dedicated side panel under the video: active cue highlighted and synced to
playback, full subtitle text selectable/copyable, click a cue to seek. Native
`<track>` is used only as fallback by the native player path. Subtitle track
priority: embedded (extracted) → uploaded file → OpenSubtitles → pasted/URL —
all shown as selectable entries in the same widget.

### Audio track switching

Demuxer lists audio tracks → tracksMenu offers selection → MSE swaps the audio
SourceBuffer. Works identically for WebTorrent and backend sources (same demux
path).

## Backend (Go)

Single binary `torwatchd`. Serves `static/` plus API.

- `anacrolix/torrent` client, one session per magnet.
- API:
  - `POST /api/magnets` `{magnet}` → `{id}` (idempotent on infohash)
  - `GET /api/magnets/{id}` → state, file list (name, size)
  - `GET /api/magnets/{id}/files/{n}` — HTTP range streaming; range requests set
    piece priorities
  - `DELETE /api/magnets/{id}`
  - `GET /api/opensubs?query=...` — OpenSubtitles proxy (optional, enabled only
    when `OPENSUBTITLES_API_KEY` env var is set)
- Retention: flags `-ttl 24h`, `-max-disk 20GB`; a ticker purges expired
  torrents and evicts LRU over the disk budget (mirrors yt-subtitles job
  cleanup).
- Deployment: cross-compile `GOOS=linux GOARCH=arm64`; systemd unit shipped in
  the repo.

## Error handling

- Demux-unsupported codec/container → message + raw file download link.
- WebTorrent stall (20 s without useful peers/pieces) → automatic fallback to
  backend source, status bar shows the switch.
- OPFS quota exceeded → play without caching, note in status bar.
- Backend unreachable while a magnet was started there → retry with backoff,
  then error card.
- All user-facing errors go through the same status bar / card pattern as
  yt-subtitles.

## Testing

- Go: API handlers via httptest with a fake torrent-client interface; retention
  purge logic with fake clock/filesystem.
- Frontend: demux (ebml, mkvDemuxer, fmp4Muxer) unit tests on tiny fixture
  files, plain `node:test`, no DOM; emitters/store tests.
- Manual checklist for MSE/OPFS paths (browser-only behaviour).
- Fixtures: small h264/aac mp4; h264/aac mkv with 2 audio tracks + embedded srt;
  one unsupported-codec mkv.

## Project location

`~/s4y/torwatch`. New git repo. Working name: **torwatch**.
