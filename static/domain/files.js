// Torrent file lists: which files play, in what order, grouped how.
// Pure (no DOM): used by the file picker and the player's next-episode link.

export const VIDEO_RE = /\.(mp4|mkv|webm)$/i;

export const isPlayable = (f) => VIDEO_RE.test(String(f?.path ?? ''));

// Natural order: "E2" before "E10", case-insensitive.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(String(a), String(b));

// Playable files in natural path order.
export function playableFiles(files) {
  return (files ?? []).filter(isPlayable).sort((a, b) => naturalCompare(a.path, b.path));
}

const dirOf = (p) => {
  const s = String(p ?? '');
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
};
export const baseName = (p) => String(p ?? '').split('/').pop();

// [{ folder, files }] in natural order. The common leading folder (the
// torrent's own top directory) is dropped from the labels; files directly
// in it get folder ''.
export function groupByFolder(files) {
  const list = playableFiles(files);
  const dirs = list.map((f) => dirOf(f.path).split('/').filter(Boolean));
  let common = dirs.length ? dirs[0].length : 0;
  for (const d of dirs) {
    let i = 0;
    while (i < common && i < d.length && d[i] === dirs[0][i]) i++;
    common = i;
  }
  const groups = new Map();
  list.forEach((f, i) => {
    const folder = dirs[i].slice(common).join('/');
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(f);
  });
  return [...groups].map(([folder, fs]) => ({ folder, files: fs }));
}

// The playable file after `index` in natural order, or null.
export function nextFile(files, index) {
  const list = playableFiles(files);
  const i = list.findIndex((f) => f.index === index);
  return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
}
