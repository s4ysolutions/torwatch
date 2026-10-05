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
import { el } from '../util/dom.js';
import { store } from '../util/store.js';

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
