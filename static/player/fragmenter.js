// Fragmenter: demuxed samples of one track (in file = decode order) → fMP4
// fragments, ready to append to that track's SourceBuffer.
//
// createFragmenter(track, emit) => { push(sample), flush() }
//   emit(bytes) receives each fragment; flush() emits what is pending (end
//   of stream). A new fragmenter per pump: a seek starts a new timeline.
//
// MKV stores presentation times only. MSE needs decode times, in decode
// order and non-decreasing:
// - Video: samples stay in file (decode) order. Decode times are the
//   presentation times sorted ascending: the i-th sample in decode order
//   decodes at the i-th smallest PTS. With B-frames that puts some
//   presentation times before their decode time; the muxer writes those as
//   negative (signed, trun v1) composition offsets — what ffmpeg's
//   negative_cts_offsets does for MSE/DASH. A sample's rank is final once
//   REORDER_WINDOW later samples are known (no stream reorders deeper).
// - Audio: no reordering. Frames have a fixed size, so the timeline is
//   continuous (previous end + frame duration); MKV's 1 ms timestamps only
//   re-anchor it at a gap or overlap (a new fragment starts there) or when
//   they drift by more than a frame.

import { fragment, decodeTime, frameDuration } from '../demux/fmp4Muxer.js';

const REORDER_WINDOW = 16;
const VIDEO_BATCH = 30; // samples per video fragment (~1 s at 30 fps)
const AUDIO_BATCH_SEC = 1;

export function createFragmenter(track, emit) {
  return track.type === 'video' ? videoFragmenter(track, emit) : audioFragmenter(track, emit);
}

function videoFragmenter(track, emit) {
  const pending = []; // samples not yet emitted, decode order
  // Presentation times (ticks) not yet handed out as decode times, sorted.
  // One pool across fragments: an emitted batch can end with a P-frame
  // whose B-frames (smaller PTS) only come in the next batch.
  const pool = [];
  let seq = 0;
  let lastDuration = 0;

  function insert(t) {
    let i = pool.length;
    while (i > 0 && pool[i - 1] > t) i--;
    pool.splice(i, 0, t);
  }

  // Emit the first n pending samples: the i-th in decode order decodes at
  // the smallest presentation time still in the pool.
  function out(n) {
    const batch = pending.splice(0, n);
    const dts = pool.splice(0, n);
    const next = pool.length ? pool[0] : null;
    const durations = dts.map((d, i) => {
      const nx = i + 1 < n ? dts[i + 1] : next;
      return nx != null ? nx - d : null;
    });
    // Last sample of the stream: no successor, reuse the previous step.
    if (durations[n - 1] == null) {
      durations[n - 1] = n > 1 ? durations[n - 2] : lastDuration || frameDuration(track, batch);
    }
    lastDuration = durations[n - 1];
    emit(fragment(track, batch, dts[0], ++seq, { durations }));
  }

  return {
    push(s) {
      pending.push(s);
      insert(decodeTime(track, s.timestamp));
      if (pending.length >= VIDEO_BATCH + REORDER_WINDOW) out(VIDEO_BATCH);
    },
    flush() {
      if (pending.length) out(pending.length);
    },
  };
}

function audioFragmenter(track, emit) {
  let pending = [];
  let seq = 0;
  let next = null; // decode time (ticks) right after the last emitted frame

  function out() {
    const batch = pending;
    pending = [];
    const dur = frameDuration(track, batch);
    const first = decodeTime(track, batch[0].timestamp);
    // Continue the timeline unless the file's own time says otherwise
    // (gap, or the first fragment after a seek).
    const base = next != null && Math.abs(first - next) <= dur ? next : first;
    next = base + dur * batch.length;
    emit(fragment(track, batch, base, ++seq, { durations: batch.map(() => dur) }));
  }

  const ticksPerSec = decodeTime(track, 1);
  return {
    push(s) {
      // A frame that doesn't follow its predecessor (gap, overlap) starts a
      // new fragment, so out() re-anchors the timeline there instead of
      // closing the gap.
      const prev = pending.at(-1);
      if (prev) {
        const frameSec = frameDuration(track, pending) / ticksPerSec;
        const dt = s.timestamp - prev.timestamp;
        if (dt < 0 || dt > frameSec * 1.5 + 0.001) out();
      }
      pending.push(s);
      if (s.timestamp - pending[0].timestamp >= AUDIO_BATCH_SEC) out();
    },
    flush() {
      if (pending.length) out();
    },
  };
}
