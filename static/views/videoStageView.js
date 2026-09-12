// videoStageView: stage <div> with <video controls>, resize grip (clone of
// yt-subtitles grip behavior + persisted width), delegates play/seek to player.
//
// videoStageView(container, props) => disposeFn
// videoStageView(props) => element (caller appends; element.dispose() unbinds)
// videoStageView(playerFactory) => element (brief shorthand)
//
// props: { playerFactory?, onReady?, widthKey?, initialWidth? }
// element API: .getVideo(), .attachPlayer(p), .playVideo(), .seekTo(sec),
//   plus .dispose() on the single-arg form.
//
// TASK 16 INTEGRATION CONTRACT (carried findings F-A / F-B — read before
// wiring the real msePlayer here):
// - F-A (load-bearing): msePlayer pump() groups samples per 1s per track and
//   only appends full groups, so the trailing partial group is dropped when
//   the demuxer is exhausted, and pump() never calls endOfStream — playback
//   stalls at the end with MediaSource readyState stuck at "open". Task 16
//   MUST, when pump's sample loop resolves: (1) flush leftovers via
//   drainGroups(groups, emit) exported here, appending each trailing batch,
//   then (2) once the append queue empties call finalizePlayback(ms)
//   exported here (calls endOfStream only when readyState === "open").
//   Until msePlayer exposes its queue/groups, do the flush + endOfStream
//   inside pump's finally.
// - F-B (load-bearing): setAudioTrack() races stale pump appends — queued
//   fragments for the old audio buffer get appended after removeSourceBuffer
//   (detached-buffer append throws) and there is no abort guard on updating
//   buffers. Task 16 MUST, before player.setAudioTrack(n): (1) invalidate
//   the pump generation via createSwitchGuard() exported here so stale pump
//   callbacks drop instead of appending, (2) abort any updating SourceBuffer
//   and clear the pending append queue, (3) only then removeSourceBuffer +
//   addSourceBuffer + init segment. Never append to a removed buffer.
// - F-C (minor, untouched): seek-before-sourceopen null guard, floating
//   pump() .catch(), unused `pumping` var — left for final triage.

import { el } from '../util/dom.js';
import { store } from '../util/store.js';

// Flush trailing partial fragment groups left over when a pump loop ends.
// groups: Map (or iterable) of key -> samples[]; emit(key, batch) appends one
// batch. Returns the number of batches flushed.
export function drainGroups(groups, emit) {
  let flushed = 0;
  for (const [key, samples] of groups ?? []) {
    if (samples && samples.length) {
      emit(key, samples.splice(0));
      flushed++;
    }
  }
  return flushed;
}

// Safe endOfStream: only when open, never throws. Returns true if called.
export function finalizePlayback(ms) {
  if (!ms || ms.readyState !== 'open') return false;
  try {
    ms.endOfStream();
    return true;
  } catch {
    return false;
  }
}

// Generation guard so stale async pump/switch callbacks drop instead of
// appending to detached buffers (F-B). Usage:
//   const guard = createSwitchGuard();
//   const tok = guard.token(); ... later: if (guard.stale(tok)) return;
//   guard.invalidate(); // before setAudioTrack / seek
export function createSwitchGuard() {
  let gen = 0;
  return {
    token: () => gen,
    invalidate: () => {
      gen++;
    },
    stale: (tok) => tok !== gen,
  };
}

function isContainer(x) {
  return x && (x.nodeType === 1 || typeof x.appendChild === 'function');
}

export function videoStageView(containerOrProps, maybeProps) {
  let container = null;
  let props;
  if (maybeProps !== undefined) {
    container = containerOrProps;
    props = maybeProps ?? {};
  } else if (typeof containerOrProps === 'function') {
    props = { playerFactory: containerOrProps };
  } else if (isContainer(containerOrProps)) {
    container = containerOrProps;
    props = {};
  } else {
    props = containerOrProps ?? {};
  }
  const {
    playerFactory,
    onReady,
    widthKey = 'stageWidth',
    initialWidth = null,
  } = props;

  const video = el('video', { id: 'stage-video', controls: true });
  const grip = el('div', { class: 'grip', title: 'Drag to resize' });
  const stage = el('div', { class: 'stage' }, [video, grip]);

  const mem = store.ns('torwatch');
  const saved = mem.get(widthKey, initialWidth);
  if (saved) stage.style.width = typeof saved === 'number' ? `${saved}px` : saved;

  let player = null;
  const api = {
    getVideo: () => video,
    attachPlayer(p) {
      player = p;
      if (typeof onReady === 'function') onReady(p);
      return p;
    },
    playVideo: () => (player ? player.play() : video.play?.()),
    seekTo: (sec) => {
      if (player) return player.seek(sec);
      video.currentTime = sec;
    },
  };
  Object.assign(stage, api);

  if (typeof playerFactory === 'function') {
    try {
      api.attachPlayer(playerFactory(video));
    } catch (e) {
      stage._playerError = e;
    }
  }

  // Resize grip: horizontal drag, width persisted.
  const onGripDown = (e) => {
    if (typeof window === 'undefined' || !e?.preventDefault) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = video.clientWidth || stage.clientWidth || 0;
    const onMove = (mv) => {
      const w = Math.max(240, startW + (mv.clientX - startX));
      stage.style.width = `${w}px`;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const w = parseInt(String(stage.style.width), 10);
      if (Number.isFinite(w)) mem.set(widthKey, w);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  grip.addEventListener('mousedown', onGripDown);

  if (container) container.appendChild(stage);

  const dispose = () => {
    grip.removeEventListener('mousedown', onGripDown);
    try {
      if (typeof player?.dispose === 'function') player.dispose();
    } catch {}
    try {
      if (typeof stage.remove === 'function') stage.remove();
      else if (container && typeof container.removeChild === 'function') container.removeChild(stage);
    } catch {}
    player = null;
  };
  if (!container) stage.dispose = dispose;
  return container ? dispose : stage;
}

export const render = videoStageView;
export default videoStageView;
