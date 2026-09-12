import { playerState } from '../domain/playerState.js';
import { store } from '../util/store.js';

const VIDEO_RE = /\.(mp4|mkv|webm)$/i;
const POLL_MS = 1000;
// C4: unbounded poll watchdog — after this long without 'ready', signal
// "waiting for peers" (phase 'waiting') but keep polling.
const WATCHDOG_MS = 60000;
const HISTORY_CAP = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pickVideoFile(files) {
  let best = null;
  for (const f of files ?? []) {
    if (!VIDEO_RE.test(f.path ?? '')) continue;
    if (!best || (f.size ?? 0) > (best.size ?? 0)) best = f;
  }
  if (!best) throw new Error('no playable video file (.mp4/.mkv/.webm)');
  return best.index;
}

function history() {
  return store.ns('torwatch');
}

export function savePosition(id, fileIndex, t) {
  history().set(`pos:${id}:${fileIndex}`, t);
}

export function loadPosition(id, fileIndex) {
  return history().get(`pos:${id}:${fileIndex}`, 0);
}

// Wire a video element's timeupdate → store. Returns unbind.
export function bindPosition(video, id, fileIndex) {
  const onTime = () => savePosition(id, fileIndex, video.currentTime);
  video.addEventListener('timeupdate', onTime);
  return () => video.removeEventListener('timeupdate', onTime);
}

// Shared poll loop: resolves with the magnet info once state === 'ready'.
// Missing/unknown states count as not-ready (C4: only 'ready' breaks the
// poll). After watchdogMs without readiness, fires onStall once (default:
// playerState phase 'waiting' → statusBar "Waiting for peers…") and keeps
// polling — the watchdog never aborts the torrent.
export async function pollMagnetReady({ adapter, id, pollMs = POLL_MS, watchdogMs = WATCHDOG_MS, onStall = null }) {
  const t0 = Date.now();
  let stalled = false;
  for (;;) {
    const info = await adapter.getMagnet(id);
    if (info.state === 'ready') return info;
    if (info.state === 'error') throw new Error(info.error || 'magnet failed');
    if (!stalled && watchdogMs > 0 && Date.now() - t0 >= watchdogMs) {
      stalled = true;
      if (typeof onStall === 'function') onStall(info);
      else {
        try {
          playerState.set({ ...playerState.get(), phase: 'waiting' });
        } catch {}
      }
    }
    await sleep(pollMs);
  }
}

export async function loadMagnet({ adapter, magnet, pollMs = POLL_MS, watchdogMs = WATCHDOG_MS, onStall = null }) {
  playerState.set({ ...playerState.get(), phase: 'loading', error: null });
  const { id } = await adapter.addMagnet(magnet);
  const info = await pollMagnetReady({ adapter, id, pollMs, watchdogMs, onStall });
  const fileIndex = pickVideoFile(info.files ?? []);
  const s = history();
  const prev = s.get('history', []);
  s.set('history', [magnet, ...prev.filter((m) => m !== magnet)].slice(0, HISTORY_CAP));
  const position = loadPosition(id, fileIndex);
  playerState.set({ ...playerState.get(), phase: 'ready', magnetId: id, fileIndex, position, error: null });
  return { id, fileIndex };
}
