// Small MediaSource helpers used by msePlayer.

// The pump groups samples per track into ~1s fragments and appends only
// full groups; when the demuxer runs out, the trailing partial groups must
// still be appended or the last second of the file is lost.
// groups: Map (or iterable) of key -> samples[]; emit(key, batch) appends
// one batch. Returns the number of batches flushed.
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

// endOfStream() once everything is appended, so playback ends instead of
// stalling with readyState stuck at "open". Only when open; never throws.
// Returns true if called.
export function finalizePlayback(ms) {
  if (!ms || ms.readyState !== 'open') return false;
  try {
    ms.endOfStream();
    return true;
  } catch {
    return false;
  }
}
