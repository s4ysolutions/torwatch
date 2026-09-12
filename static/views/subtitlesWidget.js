// subtitlesWidget: panel under the video — active cue highlighted via
// timeupdate, full cue list scrollable/selectable, click cue seeks,
// "Copy all" button, "Find online…" button.
//
// subtitlesWidget(container, props) => disposeFn
// subtitlesWidget(props) => element (caller appends; element.dispose() unbinds)
// subtitlesWidget(tracksEmitter, videoEl, onSeek) => element (brief shorthand)
//
// props: { emitter|tracks, video|videoEl, onSeek, title?, searchSubs?,
//   fetchText?, loadExternal?, onCopy? }
//   searchSubs(title) => Promise<{results:[{fileName,language,downloadUrl}]}>
//     (Task 16 wires backendAdapter().searchSubs). fetchText defaults to
//     global fetch. loadExternal defaults to addExternalSubs (same track
//     list). onCopy(text) overrides clipboard write (test hook).
//
// Online flow per plan: Find online… → searchSubs(title) → result buttons →
// click result → fetchText(downloadUrl) → loadExternal({name, text}) parses
// into the same track list, which repaints this panel via the emitter.

import { el } from '../util/dom.js';
import { addExternalSubs } from '../usecases/loadSubtitles.js';

// Binary-search-led pure helper: index of cue containing t (start <= t < end),
// cues sorted by start. Gap / empty / NaN => -1. With overlaps, returns the
// latest-starting cue containing t.
export function activeCueIndex(cues, t) {
  if (!Array.isArray(cues) || !cues.length) return -1;
  if (typeof t !== 'number' || Number.isNaN(t)) return -1;
  let lo = 0;
  let hi = cues.length - 1;
  let cand = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      cand = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (cand < 0) return -1;
  const fast = cues[cand];
  if (fast.start <= t && t < fast.end) return cand;
  for (let i = cand - 1; i >= 0; i--) {
    const c = cues[i];
    if (c.start <= t && t < c.end) return i;
  }
  return -1;
}

function isContainer(x) {
  return x && (x.nodeType === 1 || typeof x.appendChild === 'function');
}

function isEmitter(x) {
  return x && typeof x.subscribe === 'function' && typeof x.get === 'function';
}

function looksLikeVideo(x) {
  return x && (x.tagName === 'VIDEO' || typeof x.currentTime === 'number' || typeof x.addEventListener === 'function');
}

function normalizeArgs(containerOrProps, maybeProps, thirdArg) {
  if (
    isEmitter(containerOrProps) &&
    (maybeProps === undefined || looksLikeVideo(maybeProps))
  ) {
    const props = { emitter: containerOrProps, video: maybeProps };
    if (typeof thirdArg === 'function') props.onSeek = thirdArg;
    return { container: null, props };
  }
  if (maybeProps !== undefined) {
    return { container: containerOrProps, props: maybeProps ?? {} };
  }
  if (isContainer(containerOrProps) && !isEmitter(containerOrProps)) {
    return { container: containerOrProps, props: {} };
  }
  return { container: null, props: containerOrProps ?? {} };
}

const fmt = (s) => {
  if (!Number.isFinite(s)) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

export function subtitlesWidget(containerOrProps, maybeProps, thirdArg) {
  let normalized = normalizeArgs(containerOrProps, maybeProps, thirdArg);
  const { container, props } = normalized;
  const emitter = props.emitter ?? props.tracks ?? props.tracksEmitter ?? null;
  const video = props.video ?? props.videoEl ?? null;
  const {
    onSeek,
    title = '',
    searchSubs,
    loadExternal,
    onCopy,
    fetchText,
  } = props;

  const titleInput = el('input', { type: 'text', class: 'subs-title', placeholder: 'Title for online search…' });
  titleInput.value = title;
  const findBtn = el('button', { type: 'button', class: 'subs-find' }, ['Find online…']);
  const copyBtn = el('button', { type: 'button', class: 'subs-copy' }, ['Copy all']);
  const status = el('span', { class: 'subs-status' });
  const list = el('ol', { class: 'cue-list' });
  list.style.overflowY = 'auto';
  const results = el('div', { class: 'subs-results' });
  const panel = el('section', { class: 'subs-widget' }, [
    el('div', { class: 'subs-bar' }, [titleInput, findBtn, copyBtn, status]),
    results,
    list,
  ]);

  let cues = [];
  let items = [];
  let activeIdx = -1;

  const say = (msg) => {
    status.textContent = msg ?? '';
  };

  function paint(state) {
    const subs = state?.subtitles ?? [];
    const entry =
      subs.find((s) => s.label === state?.activeSubtitle) ?? null;
    cues = entry?.cues ?? [];
    items = [];
    activeIdx = -1;
    while (list.firstChild && typeof list.removeChild === 'function') {
      try {
        list.removeChild(list.firstChild);
      } catch {
        break;
      }
    }
    if (!cues.length) {
      list.appendChild(el('li', { class: 'cue-empty' }, ['No subtitles']));
      return;
    }
    cues.forEach((cue, i) => {
      const li = el('li', { class: 'cue' }, [
        el('span', { class: 'cue-time' }, [`${fmt(cue.start)} `]),
        el('span', { class: 'cue-text' }, [cue.text]),
      ]);
      const onClick = () => {
        if (typeof onSeek === 'function') onSeek(cue.start);
      };
      li.addEventListener('click', onClick);
      li._cueDispose = () => li.removeEventListener('click', onClick);
      items.push(li);
      list.appendChild(li);
    });
    if (video && typeof video.currentTime === 'number') highlight(video.currentTime);
  }

  function highlight(t) {
    const idx = activeCueIndex(cues, t);
    if (idx === activeIdx) return idx;
    if (items[activeIdx]?.classList) items[activeIdx].classList.remove('active');
    activeIdx = idx;
    if (items[idx]?.classList) {
      items[idx].classList.add('active');
      if (typeof items[idx].scrollIntoView === 'function') {
        try {
          items[idx].scrollIntoView({ block: 'nearest' });
        } catch {}
      }
    }
    return idx;
  }

  const onTime = () => {
    if (video && typeof video.currentTime === 'number') highlight(video.currentTime);
  };
  if (video?.addEventListener) video.addEventListener('timeupdate', onTime);

  const doCopy = () => {
    const text = cues.map((c) => `${fmt(c.start)} ${c.text}`).join('\n');
    if (typeof onCopy === 'function') {
      onCopy(text);
      say(`Copied ${cues.length} cues`);
      return;
    }
    try {
      const clip = globalThis.navigator?.clipboard;
      if (clip?.writeText) {
        clip.writeText(text).then(
          () => say(`Copied ${cues.length} cues`),
          (e) => say(`Copy failed: ${e?.message ?? e}`),
        );
      } else {
        say('Copy unavailable');
      }
    } catch (e) {
      say(`Copy failed: ${e?.message ?? e}`);
    }
  };
  copyBtn.addEventListener('click', doCopy);

  const defaultFetchText = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`subtitle fetch ${r.status}`);
    return r.text();
  };

  const doFind = () => {
    const q = (titleInput.value ?? '').trim();
    if (!q) {
      say('Enter a title to search');
      return;
    }
    if (typeof searchSubs !== 'function') {
      say('Online search unavailable');
      return;
    }
    say('Searching…');
    searchSubs(q).then(
      (res) => {
        const found = res?.results ?? res ?? [];
        while (results.firstChild && typeof results.removeChild === 'function') {
          try {
            results.removeChild(results.firstChild);
          } catch {
            break;
          }
        }
        if (!found.length) {
          say('No subtitles found');
          return;
        }
        say(`Found ${found.length} — pick one`);
        for (const r of found) {
          const b = el('button', { type: 'button', class: 'subs-result' }, [
            `${r.fileName ?? r.name ?? 'subtitle'}${r.language ? ` [${r.language}]` : ''}`,
          ]);
          const onPick = () => {
            say(`Loading ${r.fileName ?? 'subtitle'}…`);
            const fetcher = typeof fetchText === 'function' ? fetchText : defaultFetchText;
            const loader = typeof loadExternal === 'function' ? loadExternal : addExternalSubs;
            fetcher(r.downloadUrl ?? r.url).then(
              (text) => loader({ name: r.fileName ?? 'online.srt', text }).then(
                () => say(`Loaded ${r.fileName ?? 'subtitle'}`),
                (e) => say(`Load failed: ${e?.message ?? e}`),
              ),
              (e) => say(`Fetch failed: ${e?.message ?? e}`),
            );
          };
          b.addEventListener('click', onPick);
          results.appendChild(b);
        }
      },
      (e) => say(`Search failed: ${e?.message ?? e}`),
    );
  };
  findBtn.addEventListener('click', doFind);

  let off = () => {};
  if (isEmitter(emitter)) {
    paint(emitter.get());
    off = emitter.subscribe(paint) ?? off;
  } else if (emitter && typeof emitter === 'object') {
    paint(emitter);
  } else {
    paint({});
  }

  if (container) container.appendChild(panel);

  const dispose = () => {
    try {
      video?.removeEventListener?.('timeupdate', onTime);
    } catch {}
    copyBtn.removeEventListener('click', doCopy);
    findBtn.removeEventListener('click', doFind);
    for (const li of items) {
      try {
        li._cueDispose?.();
      } catch {}
    }
    try {
      off();
    } catch {}
    try {
      if (typeof panel.remove === 'function') panel.remove();
      else if (container && typeof container.removeChild === 'function') container.removeChild(panel);
    } catch {}
  };
  if (!container) panel.dispose = dispose;
  panel.highlight = highlight;
  panel.activeIndex = () => activeIdx;
  return container ? dispose : panel;
}

export const render = subtitlesWidget;
export default subtitlesWidget;
