// downloadsRow view: ⬇ links for the video file URL and the active
// subtitle's .srt URL. Pull-based via getUrls (no adapter/fetch use):
//
// getUrls() => { videoUrl?, videoName?, srtUrl?, srtLabel? }
//
// downloadsRow(container, getUrls) => disposeFn
// downloadsRow(getUrls) => element (caller appends)

import { el } from '../util/dom.js';

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

  const { videoUrl = null, videoName = 'video', srtUrl = null, srtLabel = '.srt' } =
    (typeof getUrls === 'function' ? getUrls() : {}) ?? {};

  const links = [];
  if (videoUrl) links.push(el('a', { href: videoUrl, download: videoName || 'video' }, ['⬇ video']));
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
