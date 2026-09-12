import { initSegment, fragment, codecString } from '../demux/fmp4Muxer.js';
// F-A/F-B helpers live in videoStageView.js (Task 15 contract): drainGroups
// flushes trailing partial fragment groups, finalizePlayback endOfStreams
// only when open. (Player→views import is intentional per that contract.)
import { drainGroups, finalizePlayback } from '../views/videoStageView.js';

export function createMsePlayer(videoEl, demuxer, trackList) {
  const ms = new MediaSource();
  videoEl.src = URL.createObjectURL(ms);
  let vbuf = null, abuf = null;
  let activeAudio = trackList.find(t => t.type === 'audio');
  const videoTrack = trackList.find(t => t.type === 'video');
  let generation = 0; // bumped by seek/setAudioTrack to cancel stale pumps
  const queue = [];   // pending appends: {buf, data}
  let pumping = false;
  let eosPending = false; // F-A: pump finished; endOfStream once queue drains

  function appendNext() {
    if (!queue.length) {
      if (eosPending) { eosPending = false; finalizePlayback(ms); }
      return;
    }
    const { buf, data } = queue[0];
    if (buf.updating) return;
    queue.shift();
    buf.appendBuffer(data);
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
      for (const b of [vbuf, abuf]) if (b?.updating) b.abort();
      queue.length = 0;
      if (vbuf) { vbuf.remove(0, Infinity); abuf.remove(0, Infinity); }
      videoEl.currentTime = sec;
      // re-append init segments then pump from sec
      queue.push({ buf: vbuf, data: initSegment(videoTrack) }, { buf: abuf, data: initSegment(activeAudio) });
      appendNext();
      pump(generation, sec);
    },
    setAudioTrack(trackNumber) {
      const t = trackList.find(x => x.type === 'audio' && x.number === trackNumber);
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
