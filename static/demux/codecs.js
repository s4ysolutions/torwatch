// Which MKV audio codecs the MSE player can use.
//
// BASE_AUDIO: muxed to fMP4 and decoded by every MSE browser — always OK.
// PASSTHROUGH_AUDIO: muxed to fMP4 as-is (MKV codec id -> MP4 codecs string),
// but only some browsers ship a decoder (Safari, Edge on Windows) — gated on
// MediaSource.isTypeSupported at runtime.

export const BASE_AUDIO = new Set(['A_AAC', 'A_MPEG/L3', 'A_OPUS']);

export const PASSTHROUGH_AUDIO = new Map([
  ['A_AC3', 'ac-3'],
  ['A_EAC3', 'ec-3'],
]);

// audioSupport(isTypeSupported?) => (track) => boolean.
// Without isTypeSupported (node, no MSE) only BASE_AUDIO is playable.
export function audioSupport(isTypeSupported = null) {
  return (track) => {
    if (BASE_AUDIO.has(track.codecId)) return true;
    const codec = PASSTHROUGH_AUDIO.get(track.codecId);
    if (!codec || typeof isTypeSupported !== 'function') return false;
    try {
      return !!isTypeSupported(`audio/mp4; codecs="${codec}"`);
    } catch {
      return false;
    }
  };
}
