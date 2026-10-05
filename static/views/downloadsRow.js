// downloadsRow view: ⬇ links for the video file URL and the active
// subtitle's .srt URL. Pull-based via getUrls (no adapter/fetch use):
//
// getUrls() => { videoUrl?, videoName?, getVideo?, srtUrl?, srtLabel? }
//   getVideo() => Promise<{url, name?}> — lazy variant for engines that
//   must build the file first (WebTorrent blob): resolved on click only.
//
// downloadsRow(container, getUrls) => disposeFn
// downloadsRow(getUrls) => element (caller appends)

import { el } from '../util/dom.js';

// <a> that resolves its target on first click, then downloads it. Never
// fetches anything until the user asks.
export function lazyDownloadLink(label, resolve, attrs = {}) {
  const a = el('a', { href: '#', ...attrs }, [label]);
  let state = 'idle';
  a.addEventListener('click', async (ev) => {
    if (state === 'ready') return; // real href now: browser downloads
    ev.preventDefault();
    if (state === 'busy') return;
    state = 'busy';
    a.textContent = `${label} (preparing…)`;
    try {
      const { url, name } = await resolve();
      a.setAttribute('href', url);
      if (name) a.setAttribute('download', name);
      a.textContent = label;
      state = 'ready';
      a.click();
    } catch (e) {
      a.textContent = `${label} (failed: ${e?.message ?? e})`;
      state = 'idle';
    }
  });
  return a;
}

function isContainer(x) {
  return x && (x.nodeType === 1 || typeof x.appendChild === 'function');
}

export function downloadsRow(containerOrGet, maybeGet) {
  let container = null;
  let getUrls;
  if (maybeGet !== undefined) {
    container = containerOrGet;
    getUrls = maybeGet;
  } else if (typeof containerOrGet === 'function') {
    getUrls = containerOrGet;
  } else {
    container = containerOrGet;
    getUrls = () => ({});
  }

  const { videoUrl = null, videoName = 'video', getVideo = null, srtUrl = null, srtLabel = '.srt' } =
    (typeof getUrls === 'function' ? getUrls() : {}) ?? {};

  const links = [];
  if (videoUrl) links.push(el('a', { href: videoUrl, download: videoName || 'video' }, ['⬇ video']));
  else if (typeof getVideo === 'function') links.push(lazyDownloadLink('⬇ video', getVideo));
  if (srtUrl) links.push(el('a', { href: srtUrl, download: srtLabel || '.srt' }, [`⬇ ${srtLabel || '.srt'}`]));

  const row = el('div', { class: 'downloads' }, links);
  if (!links.length) row.style.display = 'none';
  if (container) container.appendChild(row);

  const dispose = () => {
    try {
      if (typeof row.remove === 'function') row.remove();
      else if (container && typeof container.removeChild === 'function') container.removeChild(row);
    } catch {}
  };
  if (!container) row.dispose = dispose;
  return container ? dispose : row;
}

export const render = downloadsRow;
export default downloadsRow;
