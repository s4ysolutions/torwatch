import { initSegment, codecString } from '../demux/fmp4Muxer.js';
import { finalizePlayback } from './mseHelpers.js';
import { createFragmenter } from './fragmenter.js';

// MSE player: demuxed MKV → fMP4 fragments → one video + one audio
// SourceBuffer.
//
// Every SourceBuffer operation (appendBuffer and remove) goes through one
// FIFO queue and starts only when its buffer is idle; abort() is never
// used. That avoids the InvalidStateError cases of the MSE spec: abort()
// during a remove(), append/remove while updating, endOfStream() while
// updating.
//
// An audio switch rebuilds the whole MediaSource at the current position
// instead of removeSourceBuffer + addSourceBuffer: browsers refuse new
// SourceBuffers once playback has started or the stream has ended.
export function createMsePlayer(videoEl, demuxer, trackList, hooks = {}) {
  const onError = typeof hooks.onError === 'function' ? hooks.onError : () => {};
  // Subtitle blocks ride along in the playback stream (no second walk of
  // the file); each one is handed to hooks.onSubtitle(sample).
  const onSubtitle = typeof hooks.onSubtitle === 'function' ? hooks.onSubtitle : null;
  const subtitleNums = onSubtitle ? trackList.filter(t => t.type === 'subtitle').map(t => t.number) : [];
  // Tracks the demuxer marked unplayable (codec the browser can't decode)
  // are never selected.
  const playableAudio = t => t.type === 'audio' && t.playable !== false;
  let activeAudio = trackList.find(playableAudio);
  const videoTrack = trackList.find(t => t.type === 'video');

  let ms = null;
  let msUrl = null;
  let vbuf = null, abuf = null;
  let generation = 0; // bumped by seek/audio switch/halt to cancel stale pumps
  const queue = []; // pending SourceBuffer ops: {buf, kind: 'append'|'remove', data?}
  let eosPending = false; // pump finished; endOfStream once everything is idle
  let halted = false;
  let disposed = false;
  let startAt = 0; // where the pump starts once the MediaSource opens
  // Audio switch bookkeeping (see setAudioTrack).
  let pumpAt = 0; // latest sample time the pump has read
  let pumpDone = false; // pump reached the end of the file
  let audioCutoff = null; // pump appends the new audio track from here on
  let backfilling = false;
  // Backpressure: pause the pump while too many ops are pending or >30s is
  // buffered ahead; resume on updateend (plus a timeout fallback).
  const MAX_QUEUE = 32;
  const MAX_AHEAD_SEC = 30;
  let pressureResolve = null;

  // Error text that says which step failed and, when the element itself
  // failed (decoder rejected data), the media error behind it — WebKit
  // reports every later append as a bare "invalid state".
  function describe(what, e) {
    const me = videoEl.error;
    const media = me ? ` (media error ${me.code}${me.message ? `: ${me.message}` : ''})` : '';
    return new Error(`${what} failed: ${e?.message ?? e}${media}`);
  }

  // Halt the pipeline once: stale every in-flight pump, drop queued ops,
  // surface one error.
  function halt(e) {
    if (halted || disposed) return;
    halted = true;
    generation++;
    queue.length = 0;
    eosPending = false;
    try {
      onError(e);
    } catch {}
  }

  function bufferedAhead() {
    try {
      const b = videoEl.buffered;
      const t = videoEl.currentTime || 0;
      if (!b || !b.length) return 0;
      return Math.max(0, b.end(b.length - 1) - t);
    } catch {
      return 0;
    }
  }

  const idle = () => !vbuf?.updating && !abuf?.updating;

  function runQueue() {
    while (queue.length) {
      const op = queue[0];
      if (op.buf.updating) break; // resumes on that buffer's updateend
      queue.shift();
      try {
        if (op.kind === 'remove') op.buf.remove(op.from ?? 0, Infinity);
        else if (op.kind === 'changeType') op.buf.changeType(op.mime); // synchronous
        else op.buf.appendBuffer(op.data);
      } catch (e) {
        const call = { remove: 'SourceBuffer.remove', changeType: 'SourceBuffer.changeType' }[op.kind] ?? 'SourceBuffer.appendBuffer';
        halt(describe(call, e));
        return;
      }
    }
    if (pressureResolve && queue.length < MAX_QUEUE) pressureResolve();
    if (eosPending && !queue.length && idle()) {
      eosPending = false;
      finalizePlayback(ms);
    }
  }

  function waitForDrain() {
    return new Promise((res) => {
      const t = setTimeout(() => {
        pressureResolve = null;
        res();
      }, 200);
      pressureResolve = () => {
        clearTimeout(t);
        pressureResolve = null;
        res();
      };
    });
  }

  async function pump(gen, fromSec) {
    // Fragments per track in decode order (see fragmenter.js); a new pump
    // (seek, audio switch) starts new timelines.
    const vfrag = createFragmenter(videoTrack, (data) => {
      queue.push({ buf: vbuf, kind: 'append', data });
      runQueue();
    });
    // The audio track can change mid-pump (setAudioTrack): a new
    // fragmenter then takes over from audioCutoff on; the backfill covers
    // the time before it.
    const audioFrag = () => createFragmenter(activeAudio, (data) => {
      queue.push({ buf: abuf, kind: 'append', data });
      runQueue();
    });
    let afrag = audioFrag();
    let afragTrack = activeAudio;
    audioCutoff = null;
    pumpAt = fromSec;
    pumpDone = false;
    // Every playable audio track is read, so a switch needs no new walk.
    const audioNums = new Set(trackList.filter(playableAudio).map(t => t.number));
    const sel = [videoTrack.number, ...audioNums, ...subtitleNums];
    const isSub = new Set(subtitleNums);
    try {
      for await (const s of demuxer.samples(fromSec, demuxer.durationSec(), sel)) {
        if (gen !== generation) return; // stale
        pumpAt = Math.max(pumpAt, s.timestamp);
        // Pause fetching while the queue is full or plenty is buffered
        // ahead; updateend (via runQueue) wakes us early.
        while (gen === generation && (queue.length >= MAX_QUEUE || bufferedAhead() > MAX_AHEAD_SEC)) {
          await waitForDrain();
        }
        if (gen !== generation) return; // stale
        if (isSub.has(s.trackNumber)) {
          try {
            onSubtitle(s);
          } catch {}
        } else if (s.trackNumber === videoTrack.number) {
          vfrag.push(s);
        } else if (s.trackNumber === activeAudio.number) {
          if (afragTrack !== activeAudio) {
            afrag = audioFrag(); // previous track's pending frames are dropped
            afragTrack = activeAudio;
          }
          if (audioCutoff == null || s.timestamp >= audioCutoff) afrag.push(s);
        }
      }
    } catch (e) {
      // Demuxer/network failure mid-stream: halt so the finally below
      // (gen now stale) skips flush/endOfStream, and surface one error.
      if (gen === generation) halt(e);
    } finally {
      // Flush what is pending, then endOfStream once idle (and once a
      // running audio backfill is done).
      if (gen === generation) {
        pumpDone = true;
        try {
          vfrag.flush();
          afrag.flush();
          if (!backfilling) eosPending = true;
          runQueue();
        } catch (e) {
          halt(e);
        }
      }
    }
  }

  // New audio track for [fromSec, untilSec): the part the pump already read
  // ahead with the previous track. Audio-only, mostly from the cache.
  async function backfill(gen, track, fromSec, untilSec) {
    backfilling = true;
    const frag = createFragmenter(track, (data) => {
      queue.push({ buf: abuf, kind: 'append', data });
      runQueue();
    });
    const live = () => gen === generation && track === activeAudio;
    try {
      for await (const s of demuxer.samples(fromSec, Infinity, [track.number])) {
        if (!live()) return;
        if (s.timestamp >= untilSec) break;
        while (live() && queue.length >= MAX_QUEUE) await waitForDrain();
        if (!live()) return;
        frag.push(s);
      }
      if (!live()) return;
      frag.flush();
    } catch (e) {
      if (live()) halt(e);
      return;
    } finally {
      if (track === activeAudio) backfilling = false;
    }
    if (pumpDone) {
      eosPending = true;
      runQueue();
    }
  }

  const mime = t => `${t.type === 'video' ? 'video' : 'audio'}/mp4; codecs="${codecString(t)}"`;

  // (Re)build the MediaSource and start streaming at sec.
  function open(sec, resume) {
    generation++;
    queue.length = 0;
    eosPending = false;
    halted = false;
    vbuf = abuf = null;
    startAt = sec;
    if (msUrl) URL.revokeObjectURL(msUrl);
    const m = new MediaSource();
    ms = m;
    msUrl = URL.createObjectURL(m);
    videoEl.src = msUrl;
    m.addEventListener('sourceopen', () => {
      if (ms !== m || disposed) return;
      try {
        // Without a duration the element reports an infinite (live)
        // stream and the seek bar can't reach unbuffered positions. Set
        // it before any SourceBuffer exists (the setter throws while one
        // is updating).
        const d = demuxer.durationSec();
        if (Number.isFinite(d) && d > 0) m.duration = d;
        vbuf = m.addSourceBuffer(mime(videoTrack));
        abuf = m.addSourceBuffer(mime(activeAudio));
      } catch (e) {
        halt(describe('MediaSource.addSourceBuffer', e));
        return;
      }
      for (const b of [vbuf, abuf]) b.addEventListener('updateend', runQueue);
      queue.unshift({ buf: vbuf, kind: 'append', data: initSegment(videoTrack) }, { buf: abuf, kind: 'append', data: initSegment(activeAudio) });
      // Restore the position once the element has metadata: a currentTime
      // set before that (readyState HAVE_NOTHING) may be dropped, leaving
      // the element at 0 with data only around startAt — a black stall.
      const restore = () => {
        if (ms !== m || disposed) return;
        if (startAt > 0) {
          ownSeekTarget = startAt;
          try {
            videoEl.currentTime = startAt;
          } catch {}
        }
        if (resume) Promise.resolve(videoEl.play?.()).catch(() => {});
      };
      if (startAt > 0 || resume) {
        if ((videoEl.readyState ?? 0) >= 1) restore();
        else videoEl.addEventListener?.('loadedmetadata', restore, { once: true });
      }
      runQueue();
      pump(generation, startAt);
    }, { once: true });
  }

  // Native controls seek by setting currentTime. A target outside what is
  // buffered needs the pump restarted there; the pump otherwise walks on
  // linearly and the jump would stall until it caught up.
  let ownSeekTarget = null;
  function isBuffered(t) {
    try {
      const b = videoEl.buffered;
      for (let i = 0; i < b.length; i++) if (t >= b.start(i) && t <= b.end(i)) return true;
    } catch {}
    return false;
  }
  const onSeeking = () => {
    const t = videoEl.currentTime || 0;
    if (ownSeekTarget != null && Math.abs(t - ownSeekTarget) < 0.05) return;
    if (!vbuf || !abuf || isBuffered(t)) return;
    api.seek(t);
  };
  // The decoder rejected data: report that, not the next append's
  // "invalid state".
  const onMediaError = () => {
    if (!videoEl.error || disposed) return;
    const me = videoEl.error;
    halt(new Error(`playback failed: media error ${me.code}${me.message ? `: ${me.message}` : ''}`));
  };
  if (typeof videoEl.addEventListener === 'function') {
    videoEl.addEventListener('seeking', onSeeking);
    videoEl.addEventListener('error', onMediaError);
  }

  const api = {
    play: () => videoEl.play(),
    pause: () => videoEl.pause(),
    seek(sec) {
      generation++;
      eosPending = false;
      queue.length = 0;
      ownSeekTarget = sec;
      try {
        videoEl.currentTime = sec;
      } catch {}
      if (!vbuf || !abuf) {
        // MediaSource not open yet: the sourceopen pump starts here.
        startAt = sec;
        return;
      }
      // Queued, so they wait for any in-flight append instead of abort().
      queue.push({ buf: vbuf, kind: 'remove' }, { buf: abuf, kind: 'remove' });
      runQueue();
      pump(generation, sec);
    },
    // Swap only the audio SourceBuffer's contents, video keeps playing:
    // changeType() to the new codec, drop audio ahead of the playhead,
    // backfill the new track up to where the pump has read, and the pump
    // continues with the new track from there. Browsers without
    // changeType get a MediaSource rebuild at the current position.
    setAudioTrack(trackNumber) {
      const t = trackList.find(x => playableAudio(x) && x.number === trackNumber);
      if (!t || t === activeAudio) return;
      activeAudio = t;
      if (!vbuf || !abuf) return; // not attached yet: attach() uses activeAudio
      if (typeof abuf.changeType !== 'function') {
        open(videoEl.currentTime || 0, !videoEl.paused);
        return;
      }
      const from = videoEl.currentTime || 0;
      const until = pumpDone ? Infinity : Math.max(pumpAt, from);
      audioCutoff = until;
      eosPending = false;
      // Old-track fragments still queued would only be removed again.
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].buf === abuf) queue.splice(i, 1);
      queue.push(
        { buf: abuf, kind: 'changeType', mime: mime(t) },
        { buf: abuf, kind: 'remove', from },
        { buf: abuf, kind: 'append', data: initSegment(t) },
      );
      runQueue();
      backfill(generation, t, from, until);
    },
    duration: () => demuxer.durationSec(),
    dispose() {
      disposed = true;
      generation++;
      queue.length = 0;
      eosPending = false;
      if (typeof videoEl.removeEventListener === 'function') {
        videoEl.removeEventListener('seeking', onSeeking);
        videoEl.removeEventListener('error', onMediaError);
      }
      videoEl.pause();
      if (msUrl) URL.revokeObjectURL(msUrl);
      videoEl.removeAttribute('src');
    },
  };
  open(0, false);
  return api;
}
