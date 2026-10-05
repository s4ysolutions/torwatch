import { initSegment, fragment, codecString } from '../demux/fmp4Muxer.js';
// F-A/F-B helpers live in videoStageView.js (Task 15 contract): drainGroups
// flushes trailing partial fragment groups, finalizePlayback endOfStreams
// only when open. (Player→views import is intentional per that contract.)
import { drainGroups, finalizePlayback } from '../views/videoStageView.js';

export function createMsePlayer(videoEl, demuxer, trackList, hooks = {}) {
  const onError = typeof hooks.onError === 'function' ? hooks.onError : () => {};
  // Halt the pipeline exactly once: stale every in-flight pump and drop
  // queued appends so a dead demuxer/buffer can't cascade exceptions.
  function halt(e) {
    generation++;
    queue.length = 0;
    try {
      onError(e);
    } catch {}
  }
  const ms = new MediaSource();
  videoEl.src = URL.createObjectURL(ms);
  let vbuf = null, abuf = null;
  // Tracks the demuxer marked unplayable (codec the browser can't decode)
  // are never selected.
  const playableAudio = t => t.type === 'audio' && t.playable !== false;
  let activeAudio = trackList.find(playableAudio);
  const videoTrack = trackList.find(t => t.type === 'video');
  let generation = 0; // bumped by seek/setAudioTrack to cancel stale pumps
  const queue = [];   // pending appends: {buf, data}
  let pumping = false;
  let eosPending = false; // F-A: pump finished; endOfStream once queue drains
  // I6 backpressure: pause the pump while too many appends are pending or
  // >30s is buffered ahead; resume on updateend (plus a timeout fallback).
  const MAX_QUEUE = 32;
  const MAX_AHEAD_SEC = 30;
  let pressureResolve = null;

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

  function appendNext() {
    if (!queue.length) {
      if (eosPending) { eosPending = false; finalizePlayback(ms); }
      return;
    }
    const { buf, data } = queue[0];
    if (!buf || buf.updating) return;
    queue.shift();
    try {
      buf.appendBuffer(data);
    } catch (e) {
      halt(e);
      return;
    }
    if (pressureResolve && queue.length < MAX_QUEUE) {
      const r = pressureResolve;
      pressureResolve = null;
      r();
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
    const sel = [videoTrack.number, activeAudio.number];
    const groups = new Map(); // trackNumber -> samples[]
    const emit = (key, batch) => {
      const tn = +String(key).split(':')[0];
      const track = tn === videoTrack.number ? videoTrack : activeAudio;
      const buf = tn === videoTrack.number ? vbuf : abuf;
      queue.push({ buf, data: fragment(track, batch, batch[0].timestamp * 90000) });
      appendNext();
    };
    try {
      for await (const s of demuxer.samples(fromSec, demuxer.durationSec(), sel)) {
        if (gen !== generation) return; // stale
        // I6: pause fetching while the append queue is full or plenty is
        // buffered ahead; updateend (via appendNext) wakes us early.
        while (gen === generation && (queue.length >= MAX_QUEUE || bufferedAhead() > MAX_AHEAD_SEC)) {
          await waitForDrain();
        }
        if (gen !== generation) return; // stale
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
      // F-A: flush trailing partial groups, then endOfStream once drained.
      if (gen === generation) {
        drainGroups(groups, emit);
        if (!queue.length) finalizePlayback(ms);
        else eosPending = true;
      }
    }
  }

  function attach() {
    const mime = t => `${t.type === 'video' ? 'video' : 'audio'}/mp4; codecs="${codecString(t)}"`;
    vbuf = ms.addSourceBuffer(mime(videoTrack));
    abuf = ms.addSourceBuffer(mime(activeAudio));
    for (const b of [vbuf, abuf]) b.addEventListener('updateend', appendNext);
    vbuf.appendBuffer(initSegment(videoTrack));
    abuf.appendBuffer(initSegment(activeAudio));
  }
  ms.addEventListener('sourceopen', () => { attach(); pump(generation, videoEl.currentTime || 0); });

  return {
    play: () => videoEl.play(),
    pause: () => videoEl.pause(),
    seek(sec) {
      generation++;
      eosPending = false;
      queue.length = 0;
      if (!vbuf || !abuf) {
        // I5: sourceopen hasn't fired yet — buffers aren't attached, so
        // there is nothing to abort/remove/queue. Just move currentTime;
        // the sourceopen pump starts from videoEl.currentTime.
        try {
          videoEl.currentTime = sec;
        } catch {}
        return;
      }
      for (const b of [vbuf, abuf]) if (b?.updating) b.abort();
      vbuf.remove(0, Infinity);
      abuf.remove(0, Infinity);
      videoEl.currentTime = sec;
      // re-append init segments then pump from sec
      queue.push({ buf: vbuf, data: initSegment(videoTrack) }, { buf: abuf, data: initSegment(activeAudio) });
      appendNext();
      pump(generation, sec);
    },
    setAudioTrack(trackNumber) {
      const t = trackList.find(x => playableAudio(x) && x.number === trackNumber);
      if (!t || t === activeAudio) return;
      activeAudio = t;
      // F-B: invalidate stale pumps, abort updating buffers, clear the
      // pending queue — BEFORE removing the old audio buffer. Never append
      // queued fragments to a removed (detached) buffer.
      generation++;
      for (const b of [vbuf, abuf]) if (b?.updating) b.abort();
      queue.length = 0;
      eosPending = false;
      if (abuf) ms.removeSourceBuffer(abuf);
      abuf = ms.addSourceBuffer(`audio/mp4; codecs="${codecString(t)}"`);
      abuf.addEventListener('updateend', appendNext);
      abuf.appendBuffer(initSegment(t));
      pump(generation, videoEl.currentTime);
    },
    duration: () => demuxer.durationSec(),
    dispose() {
      generation++;
      eosPending = false;
      videoEl.pause();
      URL.revokeObjectURL(videoEl.src);
      videoEl.removeAttribute('src');
    },
  };
}
