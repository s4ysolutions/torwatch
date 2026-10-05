// filePickerView: choose which video of a multi-file torrent to play
// (season packs). Files grouped by folder, natural order, with size and a
// resume marker for started ones.
//
// filePickerView(container, { name, files, positionOf(index) => sec,
//   watchedOf(index) => bool, hrefFor(index) => string, otherCount,
//   lastIndex?, continueIndex?, durationOf?(index) => sec }) => disposeFn
// durationOf, when known, turns the position into a progress bar.
// lastIndex marks (and scrolls to) the last played episode; continueIndex
// adds a "Continue" link at the top.

import { el } from '../util/dom.js';
import { formatBytes } from '../util/format.js';
import { groupByFolder, baseName, playableFiles } from '../domain/files.js';

const clock = (sec) => {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
};

export function filePickerView(container, props) {
  const {
    name = '', files = [], positionOf = () => 0, watchedOf = () => false, hrefFor, otherCount = 0,
    lastIndex = null, continueIndex = null, durationOf = () => 0,
  } = props ?? {};
  // 0..1, or null when there is nothing to show (not started, or no
  // duration saved yet); a watched episode is full.
  const progressOf = (index, pos) => {
    if (pos <= 0) return watchedOf(index) ? 1 : null;
    const dur = durationOf(index);
    return dur > 0 ? Math.min(1, pos / dur) : null;
  };
  const bar = (frac, label) => el('div', {
    class: 'picker-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
    'aria-valuenow': String(Math.round(frac * 100)), 'aria-label': label,
  }, [el('div', { class: 'picker-progress-fill', style: `width:${(frac * 100).toFixed(1)}%` })]);
  const groups = groupByFolder(files);
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  const body = [
    el('a', { href: '#/', class: 'back-link' }, '← New magnet'),
    el('h2', { class: 'picker-title' }, name || 'Choose a video'),
    el('div', { class: 'picker-meta' }, `${total} videos${otherCount ? ` · ${otherCount} other files` : ''}`),
  ];
  const cont = continueIndex == null ? null : playableFiles(files).find((f) => f.index === continueIndex);
  if (cont) {
    const pos = positionOf(cont.index);
    body.push(el('div', { class: 'picker-continue' }, [
      el('a', { href: hrefFor(cont.index) }, `▶ Continue: ${baseName(cont.path)}`),
      pos > 0 ? el('span', { class: 'picker-resume' }, ` · from ${clock(pos)}`) : null,
    ]));
  }
  let lastRow = null;
  for (const g of groups) {
    const items = g.files.map((f) => {
      const pos = positionOf(f.index);
      const isLast = f.index === lastIndex;
      const dur = durationOf(f.index);
      const frac = progressOf(f.index, pos);
      const row = el('li', isLast ? { class: 'picker-last' } : {}, [
        el('a', { href: hrefFor(f.index), class: 'picker-file' }, baseName(f.path)),
        el('span', { class: 'picker-size' }, ` ${formatBytes(f.size ?? 0)}`),
        pos > 0 ? el('span', { class: 'picker-resume' }, ` · resume at ${clock(pos)}${dur > 0 ? ` / ${clock(dur)}` : ''}`) : null,
        pos <= 0 && watchedOf(f.index) ? el('span', { class: 'picker-resume' }, ' · ✓ watched') : null,
        isLast ? el('span', { class: 'picker-resume' }, ' · last watched') : null,
        frac != null ? bar(frac, `${baseName(f.path)}: ${Math.round(frac * 100)}% watched`) : null,
      ]);
      if (isLast) lastRow = row;
      return row;
    });
    body.push(el('section', { class: 'picker-group' }, [
      g.folder ? el('h3', {}, g.folder) : null,
      el('ol', {}, items),
    ]));
  }
  const root = el('div', { class: 'picker' }, body);
  container.appendChild(root);
  // A long season pack: bring the last watched episode into view.
  try {
    lastRow?.scrollIntoView?.({ block: 'center' });
  } catch {}
  return () => root.remove();
}
