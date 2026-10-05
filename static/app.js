// torwatch app shell: hash routes, view mounts, player wiring.
//
// Routes (meridian style — single mount fn, teardown previous on change):
//   `#/`            home: inputCard.
//   `#/play/:id/:file` play: stage + tracks menu + subtitles widget + downloads row.
//
// Player choice: `.mkv` → demux (MkvDemuxer) + MSE player (multi-audio/subs
// need track switching); anything else (`.mp4`/`.webm`/…) → native player
// with the direct file URL.
// .mp4 is not EBML so its header can't be probed for track counts — native
// playback is the default there; embedded-track switching stays an mkv
// feature in this version.

import { route, go } from './domain/route.js';
import { playerState } from './domain/playerState.js';
import { tracks } from './domain/tracks.js';
import { backendAdapter } from './adapters/backendAdapter.js';
import { webtorrentAdapter } from './adapters/webtorrentAdapter.js';
import { store } from './util/store.js';
import { opfsAdapter } from './adapters/opfsAdapter.js';
import {
  loadMagnet,
  pollMagnetReady,
  pickVideoFile,
  NoPlayableError,
  loadPosition,
  bindPosition,
} from './usecases/loadMagnet.js';
import { el } from './util/dom.js';
import { cachingFetchRange } from './usecases/cacheFile.js';
import { addExternalSubs } from './usecases/loadSubtitles.js';
import { switchAudio } from './usecases/switchAudio.js';
import { MkvDemuxer, finishCues } from './demux/mkvDemuxer.js';
import { audioSupport } from './demux/codecs.js';
import { createMsePlayer } from './player/msePlayer.js';
import { createNativePlayer } from './player/nativePlayer.js';
import { inputCardView } from './views/inputCardView.js';
import { statusBar } from './views/statusBar.js';
import { videoStageView } from './views/videoStageView.js';
import { tracksMenu } from './views/tracksMenu.js';
import { subtitlesWidget } from './views/subtitlesWidget.js';
import { downloadsRow, lazyDownloadLink } from './views/downloadsRow.js';

const $ = (id) => document.getElementById(id);

// Bound the user-visible stall signal; the poll itself stays unbounded
// (server-side torrent may take arbitrarily long) — loadMagnet's watchdog
// flips phase to 'waiting' after this long, poll breaks only on 'ready'.
const WATCHDOG_MS = 60000;

let adapter = null;
let opfs = opfsAdapter(null); // upgraded to OPFS dir at boot when available
// Subs file picked on home (no video there yet) → loaded on play mount.
let pendingSubs = null;

// Engine store + id normalization (single choke point; both WebTorrent
// infoHash and anacrolix `HexString()` are lowercase hex (`%x`) — lowercase
// everywhere anyway (no-op for server ids, required for WebTorrent ids) so
// the OPFS key `${id}:${index}` and routes match across engines).
const engineStore = store.ns('torwatch');
const getEngine = () => engineStore.get('engine', 'browser');
const normId = (s) => String(s).toLowerCase();

// AC-3/E-AC-3 pass through to MSE only where the browser decodes them.
const canPlayAudio = audioSupport((mime) => globalThis.MediaSource?.isTypeSupported?.(mime) ?? false);

// Capability check runs *before* selecting the engine (client creation is
// lazy, so try/catch around the factory cannot catch it).
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
adapter = buildAdapter(getEngine());

function fail(e) {
  playerState.set({ ...playerState.get(), phase: 'error', error: e?.message ?? String(e) });
}

// Cleanup/teardown steps: one failing step must not stop the rest, but
// the failure is logged rather than swallowed.
function attempt(what, fn) {
  try {
    fn();
  } catch (e) {
    console.warn(`torwatch: ${what} failed`, e);
  }
}

const revokeAll = (urls) => {
  for (const u of urls.splice(0)) URL.revokeObjectURL(u);
};

function clear(node) {
  node?.replaceChildren();
}

// --- home actions -----------------------------------------------------------

// Unplayable torrent (e.g. all .avi): the error goes to the status bar and
// every file gets a direct download link below the card.
let fileLinkUrls = [];
// Video download for one file. Server engine: a plain URL. Browser engine:
// the Blob (whole file in memory) is built only when the link is clicked;
// its object URL goes to blobUrls for the caller to revoke.
function lazyFileSource(id, index, name, blobUrls) {
  return async () => {
    const dl = await adapter.downloadFile(id, index);
    if (dl.url) return { url: dl.url, name };
    const url = URL.createObjectURL(dl.blob);
    blobUrls.push(url);
    return { url, name };
  };
}

function showFileLinks(info) {
  const host = $('dl');
  if (!host || !info) return;
  clear(host);
  revokeAll(fileLinkUrls);
  const row = el('div', { class: 'downloads' });
  host.appendChild(row);
  const id = normId(info.id);
  for (const f of info.files ?? []) {
    const name = String(f.path ?? `file-${f.index}`).split('/').pop();
    const label = `⬇ ${name} (${Math.round((f.size ?? 0) / 1048576)} MB)`;
    const direct = adapter.downloadUrl?.(id, f.index);
    row.appendChild(direct
      ? el('a', { href: direct, download: name }, label)
      : lazyDownloadLink(label, lazyFileSource(id, f.index, name, fileLinkUrls)));
  }
}

function failWithFiles(e) {
  fail(e);
  if (e instanceof NoPlayableError) showFileLinks(e.info);
}

async function submitMagnet(magnet) {
  playerState.set({ ...playerState.get(), phase: 'fetching', error: null, note: null });
  try {
    const { id, fileIndex } = await loadMagnet({ adapter, magnet, pollMs: 1000, watchdogMs: WATCHDOG_MS });
    go(`#/play/${normId(id)}/${fileIndex}`);
  } catch (e) {
    failWithFiles(e);
  }
}

async function submitTorrent(file) {
  playerState.set({ ...playerState.get(), phase: 'fetching', error: null, note: null });
  try {
    const buf = await file.arrayBuffer();
    const { id: rawId } = await adapter.addTorrentFile(buf);
    const id = normId(rawId);
    // Same poll contract as loadMagnet: unbounded, 'waiting' after
    // WATCHDOG_MS, breaks only on state === 'ready'.
    const info = await pollMagnetReady({ adapter, id, pollMs: 1000, watchdogMs: WATCHDOG_MS });
    const fileIndex = pickVideoFile(info.files ?? [], { id, ...(info ?? {}) });
    playerState.set({ ...playerState.get(), phase: 'ready', magnetId: id, fileIndex, error: null });
    go(`#/play/${id}/${fileIndex}`);
  } catch (e) {
    failWithFiles(e);
  }
}

async function stashSubs(file) {
  try {
    pendingSubs = { name: file.name || 'subs.srt', text: await file.text() };
    playerState.set({ ...playerState.get(), note: `staged ${pendingSubs.name} — press Watch` });
  } catch (e) {
    fail(e);
  }
}

// --- cue → srt (for the downloads row blob link) -----------------------------

function srtTs(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s - h * 3600 - m * 60;
  const whole = Math.floor(rest);
  const ms = Math.floor((rest - whole) * 1000);
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(whole, 2)},${p(ms, 3)}`;
}

function toSrt(cues) {
  return (cues ?? [])
    .map((c, i) => `${i + 1}\n${srtTs(c.start)} --> ${srtTs(c.end)}\n${c.text ?? ''}\n`)
    .join('\n');
}

// --- mounts -----------------------------------------------------------------

function mountHome() {
  playerState.set({ ...playerState.get(), phase: 'idle', error: null });
  fileLinkUrls = [];
  const host = $('card');
  clear(host);
  // Toggle invariant: the toggle lives only on the home card, and home
  // mounts only at phase `idle` — so there is deliberately no mid-play
  // engine switch to handle.
  const dispose = inputCardView(host, {
    onMagnet: (m) => void submitMagnet(m),
    onTorrentFile: (f) => void submitTorrent(f),
    onSubsFile: (f) => void stashSubs(f),
    onEngine: (v) => {
      const ph = playerState.get()?.phase;
      if (ph !== 'idle' && ph !== 'error') return;
      engineStore.set('engine', v); adapter = buildAdapter(v);
    },
  });
  return () => {
    revokeAll(fileLinkUrls);
    attempt('home card dispose', dispose);
    clear(host);
  };
}

function mountPlay({ id: rawId, file }) {
  const id = rawId == null ? rawId : normId(rawId);
  const fileIndex = Number(file);
  const disposers = [];
  const on = (off) => {
    if (typeof off === 'function') disposers.push(off);
  };
  const stageHost = $('stage');
  const subsHost = $('subs');
  const dlHost = $('dl');
  clear(stageHost);
  clear(subsHost);
  clear(dlHost);
  stageHost.appendChild(el('a', { href: '#/', class: 'back-link' }, '← New magnet'));

  let cancelled = false;
  let player = null;
  let demuxer = null;
  // Embedded subtitle cues arrive with the playback stream (msePlayer
  // onSubtitle) — the file is never walked a second time just for them.
  // trackNumber -> Map(key -> cue); flushed into `tracks` at most 2x/s.
  const embeddedCues = new Map();
  let subsFlushTimer = null;
  function flushEmbeddedSubs() {
    subsFlushTimer = null;
    if (cancelled) return;
    const now = tracks.get();
    tracks.set({
      ...now,
      subtitles: now.subtitles.map((s) =>
        s.embedded != null && embeddedCues.has(s.embedded)
          ? { ...s, cues: finishCues([...embeddedCues.get(s.embedded).values()]) }
          : s),
    });
  }
  function onEmbeddedSubtitle(sample) {
    if (cancelled || !demuxer) return;
    const cue = demuxer.subtitleCue(sample);
    let m = embeddedCues.get(sample.trackNumber);
    if (!m) embeddedCues.set(sample.trackNumber, (m = new Map()));
    m.set(`${cue.start}|${cue.text}`, cue); // re-walks after a seek dedupe
    if (!subsFlushTimer) subsFlushTimer = setTimeout(flushEmbeddedSubs, 500);
  }
  on(() => clearTimeout(subsFlushTimer));

  if (!id || !Number.isInteger(fileIndex) || fileIndex < 0) {
    fail(new Error('bad play route — go back and Watch again'));
    return () => {};
  }

  // Stage. The container form returns only a disposeFn, so
  // grab the <video> the view rendered for player attach + position wiring.
  on(videoStageView(stageHost, {}));
  const video = stageHost.querySelector('video');
  if (!video) {
    fail(new Error('video element missing'));
    return () => {};
  }

  // Restore saved position on mount; persist on timeupdate.
  const pos = loadPosition(id, fileIndex);
  if (pos > 0) {
    const apply = () => attempt('restore position', () => { video.currentTime = pos; });
    if (video.readyState >= 1) apply();
    else video.addEventListener('loadedmetadata', apply, { once: true });
  }
  on(bindPosition(video, id, fileIndex));

  // Subtitles widget. Online search hits the backend
  // OpenSubtitles proxy; results load into the same track list.
  on(
    subtitlesWidget(subsHost, {
      emitter: tracks,
      video,
      onSeek: (sec) => attempt('seek', () => {
        if (player && typeof player.seek === 'function') player.seek(sec);
        else video.currentTime = sec;
      }),
      title: '',
      searchSubs: (q) => adapter.searchSubs(q),
    }),
  );

  async function selectSubtitle(label, checked) {
    try {
      const cur = tracks.get();
      if (!checked) {
        if (cur.activeSubtitle === label) tracks.set({ ...cur, activeSubtitle: null });
        return;
      }
      tracks.set({ ...cur, activeSubtitle: label });
    } catch (e) {
      fail(e);
    }
  }

  // Tracks menu (props form: the 2-arg shorthand has no subtitle callback).
  // msePlayer.setAudioTrack does the SourceBuffer swap; here we delegate.
  on(
    tracksMenu(stageHost, {
      emitter: tracks,
      onSwitch: (n) => void switchAudio({ player, trackNumber: n }).catch(fail),
      onSubtitle: (label, checked) => void selectSubtitle(label, checked),
    }),
  );

  // Downloads row: pull-once view, re-rendered on state change.
  let dlDispose = null;
  let srtUrl = null;
  const videoBlobUrls = [];
  // One lazy source per mount: re-renders (every subtitle flush) reuse it,
  // so a click never builds the file twice; its blob URL lives until
  // unmount.
  let fileName = `file-${fileIndex}`;
  let videoSource = null;
  const getVideo = () => {
    videoSource ??= lazyFileSource(id, fileIndex, fileName, videoBlobUrls)().catch((e) => {
      videoSource = null;
      throw e;
    });
    return videoSource;
  };
  const renderDl = () => {
    if (cancelled) return;
    if (typeof dlDispose === 'function') attempt('downloads row dispose', dlDispose);
    dlDispose = null;
    if (srtUrl) {
      URL.revokeObjectURL(srtUrl);
      srtUrl = null;
    }
    const st = tracks.get();
    const active = st.subtitles.find((s) => s.label === st.activeSubtitle);
    let srtLink = null;
    let srtLabel = '.srt';
    if (active?.cues?.length) {
      srtUrl = URL.createObjectURL(new Blob([toSrt(active.cues)], { type: 'text/srt' }));
      srtLink = srtUrl;
      srtLabel = active.label || '.srt';
    }
    const videoUrl = adapter.downloadUrl?.(id, fileIndex) ?? null;
    dlDispose = downloadsRow(dlHost, () => ({ videoUrl, videoName: fileName, getVideo, srtUrl: srtLink, srtLabel }));
  };
  renderDl();
  on(tracks.subscribe(renderDl));
  on(playerState.subscribe(renderDl));
  on(() => {
    if (typeof dlDispose === 'function') attempt('downloads row dispose', dlDispose);
    if (srtUrl) {
      URL.revokeObjectURL(srtUrl);
      srtUrl = null;
    }
    revokeAll(videoBlobUrls);
  });

  // Resolve the file + attach the player. Deep links reuse the same
  // unbounded poll contract as Watch (60s watchdog → 'waiting', breaks
  // only on 'ready'), so opening #/play/... early waits for peers instead
  // of throwing "not ready yet".
  playerState.set({ ...playerState.get(), phase: 'fetching', error: null });
  pollMagnetReady({ adapter, id, pollMs: 1000, watchdogMs: WATCHDOG_MS })
    .then(async (info) => {
      if (cancelled) return;
      const f = (info.files ?? []).find((x) => x.index === fileIndex);
      const name = f?.path ?? `file-${fileIndex}`;
      fileName = String(name).split('/').pop() || fileName;
      if (/\.mkv$/i.test(name)) {
        // Demux + MSE path (multi-audio/subs need track switching).
        const fetchRange = cachingFetchRange(opfs, adapter, id, fileIndex);
        demuxer = new MkvDemuxer(fetchRange, { canPlayAudio });
        const { tracks: htracks } = await demuxer.readHeader();
        if (cancelled) return;
        const audio = htracks.filter((t) => t.type === 'audio');
        const firstPlayable = audio.find((t) => t.playable !== false);
        const subs = htracks.filter((t) => t.type === 'subtitle');
        tracks.set({
          audio: audio.map((t) => ({
            number: t.number,
            language: t.language,
            name: t.name,
            codecId: t.codecId,
            playable: t.playable !== false,
          })),
          // cues fill in as playback streams past them
          subtitles: subs.map((t) => ({ label: t.name || t.language || `Track ${t.number}`, embedded: t.number, cues: [] })),
          activeAudio: firstPlayable ? firstPlayable.number : null,
          activeSubtitle: null,
        });
        if (pendingSubs) {
          const p = pendingSubs;
          pendingSubs = null;
          await addExternalSubs({ name: p.name, text: p.text });
          if (cancelled) return;
        }
        player = createMsePlayer(video, demuxer, htracks, {
          onSubtitle: onEmbeddedSubtitle,
          onError: (e) => {
            if (!cancelled) fail(e);
          },
        });
      } else {
        // Native path: direct file URL, browser decodes.
        tracks.set({ audio: [], subtitles: [], activeAudio: null, activeSubtitle: null });
        if (pendingSubs) {
          const p = pendingSubs;
          pendingSubs = null;
          await addExternalSubs({ name: p.name, text: p.text });
          if (cancelled) return;
        }
        player = createNativePlayer(video, (el) => adapter.attachNative(id, fileIndex, el));
        if (player.ready?.catch) player.ready.catch((e) => { if (!cancelled) fail(e); });
      }
      playerState.set({ ...playerState.get(), phase: 'playing', magnetId: id, fileIndex, error: null });
    })
    .catch((e) => {
      if (!cancelled) fail(e);
    });

  return () => {
    cancelled = true;
    for (const off of disposers.splice(0)) attempt('play view dispose', off);
    if (player && typeof player.dispose === 'function') attempt('player dispose', () => player.dispose());
    video.pause();
    clear(stageHost);
    clear(subsHost);
    clear(dlHost);
    tracks.set({ audio: [], subtitles: [], activeAudio: null, activeSubtitle: null });
  };
}

// Single mount function; teardown previous on route change.
function mount(r) {
  if (r && r.name === 'play' && r.params && r.params.id != null && r.params.file != null) {
    return mountPlay(r.params);
  }
  return mountHome();
}

async function ensureSw() {
  try {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) await navigator.serviceWorker.register('/sw.js');
    return true;
  } catch { return false; }
}

window.addEventListener('DOMContentLoaded', async () => {
  // Adapters: backend always; OPFS chunk cache when the browser offers it.
  // Force the stored label to the engine actually used so the checked radio
  // matches (no WebTorrent/WebRTC → server).
  if (getEngine() === 'browser' && !canUseBrowserEngine()) engineStore.set('engine', 'server');
  adapter = buildAdapter(getEngine());
  // streamTo needs the worker controlling the page, so the very first
  // browser-engine native play after first install may need one reload —
  // see docs/manual-checklist.md.
  if (getEngine() === 'browser') void ensureSw();
  try {
    const root = await globalThis.navigator?.storage?.getDirectory?.();
    opfs = opfsAdapter(root ?? null);
  } catch {
    opfs = opfsAdapter(null);
  }

  // Mount-point shells carry the yt-subtitles `#status`/`#stage` styles for
  // the VIEW nodes inside them — take the shells out of layout so their own
  // `display:none` doesn't hide the views (the views carry the look).
  $('status').style.display = 'contents';
  $('stage').style.display = 'contents';

  // Global status line (busy while phase is `fetching`).
  try {
    statusBar($('status'), playerState);
  } catch (e) {
    fail(e);
  }

  let teardown = () => {};
  try {
    teardown = mount(route.get()) || (() => {});
  } catch (e) {
    fail(e);
  }
  route.subscribe((r) => {
    attempt('route teardown', teardown);
    try {
      teardown = mount(r) || (() => {});
    } catch (e) {
      teardown = () => {};
      fail(e);
    }
  });
});
