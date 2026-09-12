import { playerState } from '../domain/playerState.js';
import { store } from '../util/store.js';

const VIDEO_RE = /\.(mp4|mkv|webm)$/i;
const POLL_MS = 1000;
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

export async function loadMagnet({ adapter, magnet, pollMs = POLL_MS }) {
  playerState.set({ ...playerState.get(), phase: 'loading', error: null });
  const { id } = await adapter.addMagnet(magnet);
  let info;
  for (;;) {
    info = await adapter.getMagnet(id);
    if (!info.state || info.state === 'ready') break;
    if (info.state === 'error') throw new Error(info.error || 'magnet failed');
    await sleep(pollMs);
  }
  const fileIndex = pickVideoFile(info.files ?? []);
  const s = history();
  const prev = s.get('history', []);
  s.set('history', [magnet, ...prev.filter((m) => m !== magnet)].slice(0, HISTORY_CAP));
  const position = loadPosition(id, fileIndex);
  playerState.set({ ...playerState.get(), phase: 'ready', magnetId: id, fileIndex, position, error: null });
  return { id, fileIndex };
}
