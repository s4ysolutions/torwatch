// Small MediaSource helpers used by msePlayer.

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
