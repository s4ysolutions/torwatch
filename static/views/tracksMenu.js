// tracksMenu: "⚙ Tracks" popover — audio radios + subtitle checkboxes fed
// by the tracks emitter. No adapter/fetch use. Callbacks only:
//
// tracksMenu(container, props) => disposeFn
// tracksMenu(props) => element (caller appends; element.dispose() unbinds)
// tracksMenu(tracksEmitter, onSwitch) => element (brief shorthand)
//
// props: { emitter|tracks|tracksEmitter, onSwitch, onSubtitle }
//   state shape: { audio: [{number, language?, name?, codecId?, playable?}],
//     subtitles: [{label}], activeAudio, activeSubtitle }
//   playable === false → radio disabled, label notes the codec.
//   onSwitch(trackNumber) — audio radio change. onSubtitle(label, checked) —
//   subtitle checkbox change (optional).
//
// NOTE (F-B contract, see videoStageView.js): the onSwitch handler in Task 16
// MUST abort updating SourceBuffers + clear the pending append queue +
// invalidate the pump generation BEFORE calling player.setAudioTrack(n).
// Never append queued fragments to a removed audio buffer.

import { el } from '../util/dom.js';

function isContainer(x) {
  return x && (x.nodeType === 1 || typeof x.appendChild === 'function');
}

function isEmitter(x) {
  return x && typeof x.subscribe === 'function' && typeof x.get === 'function';
}

function normalizeArgs(containerOrProps, maybeProps) {
  if (typeof containerOrProps === 'object' && typeof maybeProps === 'function') {
    return { container: null, props: { emitter: containerOrProps, onSwitch: maybeProps } };
  }
  if (maybeProps !== undefined) {
    return { container: containerOrProps, props: maybeProps ?? {} };
  }
  if (isContainer(containerOrProps) && !isEmitter(containerOrProps)) {
    return { container: containerOrProps, props: {} };
  }
  if (isEmitter(containerOrProps)) {
    return { container: null, props: { emitter: containerOrProps } };
  }
  return { container: null, props: containerOrProps ?? {} };
}

export function tracksMenu(containerOrProps, maybeProps) {
  const { container, props } = normalizeArgs(containerOrProps, maybeProps);
  const emitter = props.emitter ?? props.tracks ?? props.tracksEmitter ?? null;
  const { onSwitch, onSubtitle } = props;

  const btn = el('button', { type: 'button', class: 'tracks-btn' }, ['⚙ Tracks']);
  const pop = el('div', { class: 'tracks-pop' });
  pop.style.display = 'none';
  const wrap = el('div', { class: 'tracks-menu' }, [btn, pop]);

  const onBtnClick = () => {
    pop.style.display = pop.style.display === 'none' ? '' : 'none';
  };
  btn.addEventListener('click', onBtnClick);

  const itemListeners = [];
  function paint(s) {
    for (const { node, ev, fn } of itemListeners.splice(0)) {
      try {
        node.removeEventListener(ev, fn);
      } catch {}
    }
    while (pop.firstChild && typeof pop.removeChild === 'function') {
      try {
        pop.removeChild(pop.firstChild);
      } catch {
        break;
      }
    }
    const state = s ?? {};
    const audio = state.audio ?? [];
    const subs = state.subtitles ?? [];

    pop.appendChild(el('div', { class: 'tracks-head' }, ['Audio']));
    if (!audio.length) pop.appendChild(el('div', { class: 'tracks-empty' }, ['No audio tracks']));
    for (const a of audio) {
      const radio = el('input', { type: 'radio', name: 'tw-audio' });
      radio.value = String(a.number);
      radio.checked = a.number === state.activeAudio;
      const label = ` ${a.language || a.name || `Track ${a.number}`}`;
      if (a.playable === false) {
        radio.disabled = true;
        const codec = String(a.codecId || 'codec').replace(/^A_/, '');
        pop.appendChild(el('label', { class: 'tracks-audio tracks-off', title: 'This browser cannot decode this audio codec' },
          [radio, `${label} (${codec}, not supported in this browser)`]));
        continue;
      }
      const onChange = () => {
        if (typeof onSwitch === 'function') onSwitch(a.number);
      };
      radio.addEventListener('change', onChange);
      itemListeners.push({ node: radio, ev: 'change', fn: onChange });
      pop.appendChild(el('label', { class: 'tracks-audio' }, [radio, label]));
    }

    pop.appendChild(el('div', { class: 'tracks-head' }, ['Subtitles']));
    if (!subs.length) pop.appendChild(el('div', { class: 'tracks-empty' }, ['No subtitles']));
    for (const sub of subs) {
      const box = el('input', { type: 'checkbox' });
      box.value = sub.label;
      box.checked = sub.label === state.activeSubtitle;
      const onChange = () => {
        if (typeof onSubtitle === 'function') onSubtitle(sub.label, box.checked);
      };
      box.addEventListener('change', onChange);
      itemListeners.push({ node: box, ev: 'change', fn: onChange });
      pop.appendChild(el('label', { class: 'tracks-sub' }, [box, ` ${sub.label}`]));
    }
  }

  let off = () => {};
  if (isEmitter(emitter)) {
    paint(emitter.get());
    off = emitter.subscribe(paint) ?? off;
  } else if (emitter && typeof emitter === 'object') {
    paint(emitter);
  } else {
    paint({});
  }

  if (container) container.appendChild(wrap);

  const dispose = () => {
    btn.removeEventListener('click', onBtnClick);
    for (const { node, ev, fn } of itemListeners.splice(0)) {
      try {
        node.removeEventListener(ev, fn);
      } catch {}
    }
    try {
      off();
    } catch {}
    try {
      if (typeof wrap.remove === 'function') wrap.remove();
      else if (container && typeof container.removeChild === 'function') container.removeChild(wrap);
    } catch {}
  };
  if (!container) wrap.dispose = dispose;
  return container ? dispose : wrap;
}

export const render = tracksMenu;
export default tracksMenu;
