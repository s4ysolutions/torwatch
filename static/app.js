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
import { opfsAdapter } from './adapters/opfsAdapter.js';
import {
  loadMagnet,
  pollMagnetReady,
  pickVideoFile,
  loadPosition,
  bindPosition,
} from './usecases/loadMagnet.js';
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

let adapter = backendAdapter();
let opfs = opfsAdapter(null); // upgraded to OPFS dir at boot when available
// Subs file picked on home (no video there yet) → loaded on play mount.
let pendingSubs = null;

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

async function submitMagnet(magnet) {
  // C3: busy hook is the `fetching` phase (statusBar shows busy + text).
  playerState.set({ ...playerState.get(), phase: 'fetching', error: null, note: null });
  try {
    const { id, fileIndex } = await loadMagnet({ adapter, magnet, pollMs: 1000, watchdogMs: WATCHDOG_MS });
    go(`#/play/${id}/${fileIndex}`);
  } catch (e) {
    fail(e);
  }
}

async function submitTorrent(file) {
  playerState.set({ ...playerState.get(), phase: 'fetching', error: null, note: null });
  try {
    const buf = await file.arrayBuffer();
    const { id } = await adapter.addTorrentFile(buf);
    // Same poll contract as loadMagnet (C4): unbounded, 'waiting' after
    // WATCHDOG_MS, breaks only on state === 'ready'.
    const info = await pollMagnetReady({ adapter, id, pollMs: 1000, watchdogMs: WATCHDOG_MS });
    const fileIndex = pickVideoFile(info.files ?? []);
    playerState.set({ ...playerState.get(), phase: 'ready', magnetId: id, fileIndex, error: null });
    go(`#/play/${id}/${fileIndex}`);
  } catch (e) {
    fail(e);
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
  const host = $('card');
  clear(host);
  // C3: container form → disposeFn.
  const dispose = inputCardView(host, {
    onMagnet: (m) => void submitMagnet(m),
    onTorrentFile: (f) => void submitTorrent(f),
    onSubsFile: (f) => void stashSubs(f),
  });
  return () => {
    try {
      dispose();
    } catch {}
    clear(host);
  };
}

function mountPlay({ id, file }) {
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
  const renderDl = () => {
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
    dlDispose = downloadsRow(dlHost, () => ({
      videoUrl: `/api/magnets/${id}/files/${fileIndex}`,
      srtUrl: srtLink,
      srtLabel,
    }));
  };
  renderDl();
  on(tracks.subscribe(renderDl));
  on(playerState.subscribe(renderDl));
  on(() => {
    try {
      if (typeof dlDispose === 'function') dlDispose();
    } catch {}
    if (srtUrl) {
      try {
        URL.revokeObjectURL(srtUrl);
      } catch {}
      srtUrl = null;
    }
  });

  // Resolve the file + attach the player.
  playerState.set({ ...playerState.get(), phase: 'fetching', error: null });
  adapter
    .getMagnet(id)
    .then(async (info) => {
      if (cancelled) return;
      if (info.state === 'error') throw new Error(info.error || 'magnet failed');
      if (info.state !== 'ready') throw new Error('torrent not ready yet — go back and Watch again');
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
        player = createMsePlayer(video, demuxer, htracks);
      } else {
        // Native path: direct file URL, browser decodes.
        tracks.set({ audio: [], subtitles: [], activeAudio: null, activeSubtitle: null });
        if (pendingSubs) {
          const p = pendingSubs;
          pendingSubs = null;
          await addExternalSubs({ name: p.name, text: p.text });
          if (cancelled) return;
        }
        player = createNativePlayer(video, `/api/magnets/${id}/files/${fileIndex}`);
      }
      playerState.set({ ...playerState.get(), phase: 'playing', magnetId: id, fileIndex, error: null });
    })
    .catch((e) => {
      if (!cancelled) fail(e);
    });

  return () => {
    cancelled = true;
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

window.addEventListener('DOMContentLoaded', async () => {
  // Adapters: backend always; OPFS chunk cache when the browser offers it.
  adapter = backendAdapter();
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
