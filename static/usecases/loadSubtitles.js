import { tracks } from '../domain/tracks.js';

export function parseSrt(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const m = lines[1]?.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const toSec = (h, mm, s, ms) => (+h) * 3600 + (+mm) * 60 + (+s) + (+ms) / 1000;
    cues.push({ start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]), text: lines.slice(2).join('\n') });
  }
  return cues;
}

const VTT_TS = /(?:(\d+):)?(\d+):(\d+)\.(\d+)\s*-->\s*(?:(\d+):)?(\d+):(\d+)\.(\d+)/;

export function parseVtt(text) {
  const cues = [];
  const toSec = (h, mm, s, ms) => (h ? (+h) * 3600 : 0) + (+mm) * 60 + (+s) + (+ms) / 1000;
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    if (!lines[0] || /^WEBVTT/.test(lines[0])) continue;
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const m = lines[ti].match(VTT_TS);
    if (!m) continue;
    cues.push({
      start: toSec(m[1], m[2], m[3], m[4]),
      end: toSec(m[5], m[6], m[7], m[8]),
      text: lines.slice(ti + 1).join('\n'),
    });
  }
  return cues;
}

function pushEntry(label, cues) {
  const cur = tracks.get();
  const entry = { label, cues };
  tracks.set({
    ...cur,
    subtitles: [...cur.subtitles, entry],
    activeSubtitle: cur.activeSubtitle ?? label,
  });
  return entry;
}

// Embedded subs via demuxer.subtitleCues(trackNumber).
export async function loadSubtitles({ demuxer, track }) {
  const n = typeof track === 'object' ? track.number : track;
  const cues = await demuxer.subtitleCues(n);
  const label = typeof track === 'object'
    ? (track.name || track.language || `Track ${track.number}`)
    : `Track ${n}`;
  pushEntry(label, cues);
  return cues;
}

// External subs: file (Blob/File with .text()/.name), {name, text}, or raw text.
export async function addExternalSubs(input, fallbackLabel = 'External') {
  let text, name;
  if (typeof input === 'string') {
    text = input;
    name = fallbackLabel;
  } else if (input && typeof input.text === 'function') {
    text = await input.text();
    name = input.name || fallbackLabel;
  } else if (input && typeof input.text === 'string') {
    text = input.text;
    name = input.name || fallbackLabel;
  } else {
    throw new Error('addExternalSubs: expected text, Blob/File, or {name, text}');
  }
  const isVtt = /^\s*WEBVTT/m.test(text) || /\.vtt$/i.test(name ?? '');
  const cues = isVtt ? parseVtt(text) : parseSrt(text);
  return pushEntry(name, cues);
}
