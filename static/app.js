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
import { MkvDemuxer, UnsupportedError } from './demux/mkvDemuxer.js';
import { createMsePlayer } from './player/msePlayer.js';
import { createNativePlayer } from './player/nativePlayer.js';
import { inputCardView } from './views/inputCardView.js';
import { statusBar } from './views/statusBar.js';
import { videoStageView } from './views/videoStageView.js';
import { tracksMenu } from './views/tracksMenu.js';
import { subtitlesWidget } from './views/subtitlesWidget.js';
import { downloadsRow } from './views/downloadsRow.js';

const $ = (id) => document.getElementById(id);

// C4: bound the user-visible stall signal; the poll itself stays unbounded
// (server-side torrent may take arbitrarily long) — loadMagnet's watchdog
// flips phase to 'waiting' after this long, poll breaks only on 'ready'.
const WATCHDOG_MS = 60000;

let adapter = null;
let opfs = opfsAdapter(null); // upgraded to OPFS dir at boot when available
// Subs file picked on home (no video there yet) → loaded on play mount.
let pendingSubs = null;

// Engine store + id normalization (single choke point; WebTorrent infoHash
// is lowercase hex, anacrolix `HexString()` uppercase — lowercase everywhere
// so the OPFS key `${id}:${index}` and routes match across engines).
const engineStore = store.ns('torwatch');
const getEngine = () => engineStore.get('engine', 'browser');
const normId = (s) => String(s).toLowerCase();

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
  try {
    playerState.set({ ...playerState.get(), phase: 'error', error: e?.message ?? String(e) });
  } catch {}
}

function clear(node) {
  try {
    node.replaceChildren();
  } catch {}
}

// --- home actions -----------------------------------------------------------

// Unplayable torrent (e.g. all .avi): the error goes to the status bar and
// every file gets a direct download link below the card.
let homeCancelled = false;
let fileLinkUrls = [];
async function showFileLinks(info) {
  const host = $('dl');
  if (!host || !info) return;
  clear(host);
  const row = el('div', { class: 'downloads' });
  host.appendChild(row);
  for (const f of info.files ?? []) {
    if (homeCancelled) return;
    const name = String(f.path ?? `file-${f.index}`).split('/').pop();
    const mb = Math.round((f.size ?? 0) / 1048576);
    let href = `/api/magnets/${normId(info.id)}/files/${f.index}`;
    try {
      const dl = await adapter.downloadFile(normId(info.id), f.index);
      if (homeCancelled) return;
      if (dl.url) href = dl.url;
      else if (dl.blob) {
        href = URL.createObjectURL(dl.blob);
        fileLinkUrls.push(href);
      }
    } catch { if (homeCancelled) return; }
    if (homeCancelled) return;
    row.appendChild(el('a', {
      href,
      download: name,
    }, `⬇ ${name} (${mb} MB)`));
  }
}

function failWithFiles(e) {
  fail(e);
  if (e instanceof NoPlayableError) void showFileLinks(e.info);
}

async function submitMagnet(magnet) {
  // C3: busy hook is the `fetching` phase (statusBar shows busy + text).
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
    // Same poll contract as loadMagnet (C4): unbounded, 'waiting' after
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
  homeCancelled = false;
  fileLinkUrls = [];
  const host = $('card');
  clear(host);
  // C3: container form → disposeFn.
  // Toggle invariant: the toggle lives only on the home card, and home
  // mounts only at phase `idle` — so there is deliberately no mid-play
  // engine switch to handle.
  const dispose = inputCardView(host, {
    onMagnet: (m) => void submitMagnet(m),
    onTorrentFile: (f) => void submitTorrent(f),
    onSubsFile: (f) => void stashSubs(f),
    onEngine: (v) => { engineStore.set('engine', v); adapter = buildAdapter(v); },
  });
  return () => {
    homeCancelled = true;
    for (const u of fileLinkUrls.splice(0)) {
      try { URL.revokeObjectURL(u); } catch {}
    }
    try {
      dispose();
    } catch {}
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
  const embeddedByLabel = new Map(); // subtitle label -> demuxer trackNumber

  if (!id || !Number.isInteger(fileIndex) || fileIndex < 0) {
    fail(new Error('bad play route — go back and Watch again'));
    return () => {};
  }

  // Stage (container form, C3). Container form returns only disposeFn, so
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
    const apply = () => {
      try {
        video.currentTime = pos;
      } catch {}
    };
    try {
      if (video.readyState >= 1) apply();
      else video.addEventListener('loadedmetadata', apply, { once: true });
    } catch {}
  }
  on(bindPosition(video, id, fileIndex));

  // Subtitles widget (container form, C3). Online search hits the backend
  // OpenSubtitles proxy; results load into the same track list.
  on(
    subtitlesWidget(subsHost, {
      emitter: tracks,
      video,
      onSeek: (sec) => {
        try {
          if (player && typeof player.seek === 'function') player.seek(sec);
          else video.currentTime = sec;
        } catch {}
      },
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
      const entry = cur.subtitles.find((s) => s.label === label);
      // Embedded track listed but cues not loaded yet → load in place
      // (replace the placeholder; never push a duplicate entry).
      if (entry && !entry.cues?.length && embeddedByLabel.has(label) && demuxer) {
        const cues = await demuxer.subtitleCues(embeddedByLabel.get(label));
        if (cancelled) return;
        const now = tracks.get();
        tracks.set({
          ...now,
          subtitles: now.subtitles.map((s) => (s.label === label ? { ...s, cues } : s)),
          activeSubtitle: label,
        });
        return;
      }
      tracks.set({ ...cur, activeSubtitle: label });
    } catch (e) {
      fail(e);
    }
  }

  // Tracks menu (C1: FULL props form — the brief 2-arg shorthand drops
  // subtitle clicks). F-B abort+clear+generation lives inside
  // msePlayer.setAudioTrack (see player/msePlayer.js); here we just delegate.
  on(
    tracksMenu(stageHost, {
      emitter: tracks,
      onSwitch: (n) => void switchAudio({ player, trackNumber: n }).catch(fail),
      onSubtitle: (label, checked) => void selectSubtitle(label, checked),
    }),
  );

  // Downloads row (C3: pull-once — re-invoke on state change, not reactive).
  let dlDispose = null;
  let srtUrl = null;
  let dlGen = 0;
  const videoBlobUrls = [];
  const renderDl = async () => {
    const gen = ++dlGen;
    const stillCurrent = () => !cancelled && gen === dlGen;
    try {
      if (typeof dlDispose === 'function') dlDispose();
    } catch {}
    dlDispose = null;
    if (srtUrl) {
      try {
        URL.revokeObjectURL(srtUrl);
      } catch {}
      srtUrl = null;
    }
    const st = tracks.get();
    const active = st.subtitles.find((s) => s.label === st.activeSubtitle);
    let srtLink = null;
    let srtLabel = '.srt';
    if (active?.cues?.length) {
      try {
        srtUrl = URL.createObjectURL(new Blob([toSrt(active.cues)], { type: 'text/srt' }));
        srtLink = srtUrl;
        srtLabel = active.label || '.srt';
      } catch {}
    }
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
  void renderDl();
  on(tracks.subscribe(renderDl));
  on(playerState.subscribe(renderDl));
  on(() => {
    dlGen++;
    try {
      if (typeof dlDispose === 'function') dlDispose();
    } catch {}
    if (srtUrl) {
      try {
        URL.revokeObjectURL(srtUrl);
      } catch {}
      srtUrl = null;
    }
    for (const u of videoBlobUrls.splice(0)) {
      try { URL.revokeObjectURL(u); } catch {}
    }
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
      if (/\.mkv$/i.test(name)) {
        // Demux + MSE path (multi-audio/subs need track switching).
        const fetchRange = cachingFetchRange(opfs, adapter, id, fileIndex);
        demuxer = new MkvDemuxer(fetchRange);
        const { tracks: htracks } = await demuxer.readHeader();
        if (cancelled) return;
        const audio = htracks.filter((t) => t.type === 'audio');
        const subs = htracks.filter((t) => t.type === 'subtitle');
        for (const t of subs) embeddedByLabel.set(t.name || t.language || `Track ${t.number}`, t.number);
        tracks.set({
          audio: audio.map((t) => ({ number: t.number, language: t.language, name: t.name })),
          subtitles: subs.map((t) => ({ label: t.name || t.language || `Track ${t.number}` })),
          activeAudio: audio.length ? audio[0].number : null,
          activeSubtitle: null,
        });
        if (pendingSubs) {
          const p = pendingSubs;
          pendingSubs = null;
          await addExternalSubs({ name: p.name, text: p.text });
          if (cancelled) return;
        }
        player = createMsePlayer(video, demuxer, htracks, {
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
    dlGen++;
    for (const off of disposers.splice(0)) {
      try {
        off();
      } catch {}
    }
    try {
      if (player && typeof player.dispose === 'function') player.dispose();
    } catch {}
    try {
      video.pause();
    } catch {}
    clear(stageHost);
    clear(subsHost);
    clear(dlHost);
    try {
      tracks.set({ audio: [], subtitles: [], activeAudio: null, activeSubtitle: null });
    } catch {}
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
  adapter = buildAdapter(getEngine());
  // streamTo needs the worker controlling the page, so the very first
  // browser-engine native play after first install may need one reload —
  // covered by a Task 7 manual step.
  void ensureSw();
  try {
    const root = await globalThis.navigator?.storage?.getDirectory?.();
    opfs = opfsAdapter(root ?? null);
  } catch {
    opfs = opfsAdapter(null);
  }

  // Mount-point shells carry the yt-subtitles `#status`/`#stage` styles for
  // the VIEW nodes inside them — take the shells out of layout so their own
  // `display:none` doesn't hide the views (the views carry the look).
  try {
    $('status').style.display = 'contents';
    $('stage').style.display = 'contents';
  } catch {}

  // Global status line (container form, C3; busy hook is `fetching`).
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
    try {
      teardown();
    } catch {}
    try {
      teardown = mount(r) || (() => {});
    } catch (e) {
      teardown = () => {};
      fail(e);
    }
  });
});
