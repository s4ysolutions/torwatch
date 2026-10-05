import { initSegment, fragment, codecString, decodeTime } from '../demux/fmp4Muxer.js';
import { drainGroups, finalizePlayback } from './mseHelpers.js';

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
        if (op.kind === 'remove') op.buf.remove(0, Infinity);
        else op.buf.appendBuffer(op.data);
      } catch (e) {
        halt(describe(op.kind === 'remove' ? 'SourceBuffer.remove' : 'SourceBuffer.appendBuffer', e));
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
    // gather samples for video + activeAudio, group per 1s per track
    const sel = [videoTrack.number, activeAudio.number, ...subtitleNums];
    const isSub = new Set(subtitleNums);
    const groups = new Map(); // trackNumber -> samples[]
    const emit = (key, batch) => {
      const tn = +String(key).split(':')[0];
      const track = tn === videoTrack.number ? videoTrack : activeAudio;
      const buf = tn === videoTrack.number ? vbuf : abuf;
      // tfdt is in the track's own timescale (90k video, sample rate audio).
      queue.push({ buf, kind: 'append', data: fragment(track, batch, decodeTime(track, batch[0].timestamp)) });
      runQueue();
    };
    try {
      for await (const s of demuxer.samples(fromSec, demuxer.durationSec(), sel)) {
        if (gen !== generation) return; // stale
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
          continue;
        }
        const key = s.trackNumber + ':' + Math.floor(s.timestamp);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
        for (const [k, samples] of groups) {
          const tn = +k.split(':')[0];
          const track = tn === videoTrack.number ? videoTrack : activeAudio;
          if (samples.length >= (track.type === 'video' ? 24 : 43) || samples.at(-1).timestamp - samples[0].timestamp >= 1) {
            emit(k, samples.splice(0));
          }
        }
      }
    } catch (e) {
      // Demuxer/network failure mid-stream: halt so the finally below
      // (gen now stale) skips flush/endOfStream, and surface one error.
      if (gen === generation) halt(e);
    } finally {
      // Flush trailing partial groups, then endOfStream once idle.
      if (gen === generation) {
        drainGroups(groups, emit);
        eosPending = true;
        runQueue();
      }
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
      if (startAt > 0) {
        ownSeekTarget = startAt;
        try {
          videoEl.currentTime = startAt;
        } catch {}
      }
      runQueue();
      pump(generation, startAt);
      if (resume) Promise.resolve(videoEl.play?.()).catch(() => {});
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
    setAudioTrack(trackNumber) {
      const t = trackList.find(x => playableAudio(x) && x.number === trackNumber);
      if (!t || t === activeAudio) return;
      activeAudio = t;
      open(videoEl.currentTime || 0, !videoEl.paused);
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
