import { initSegment, fragment, codecString } from '../demux/fmp4Muxer.js';

export function createMsePlayer(videoEl, demuxer, trackList) {
  const ms = new MediaSource();
  videoEl.src = URL.createObjectURL(ms);
  let vbuf = null, abuf = null;
  let activeAudio = trackList.find(t => t.type === 'audio');
  const videoTrack = trackList.find(t => t.type === 'video');
  let generation = 0; // bumped by seek/setAudioTrack to cancel stale pumps
  const queue = [];   // pending appends: {buf, data}
  let pumping = false;

  function appendNext() {
    if (!queue.length) return;
    const { buf, data } = queue[0];
    if (buf.updating) return;
    queue.shift();
    buf.appendBuffer(data);
  }

  async function pump(gen, fromSec) {
    // gather samples for video + activeAudio, group per 1s per track
    const sel = [videoTrack.number, activeAudio.number];
    const groups = new Map(); // trackNumber -> samples[]
    for await (const s of demuxer.samples(fromSec, demuxer.durationSec(), sel)) {
      if (gen !== generation) return; // stale
      const key = s.trackNumber + ':' + Math.floor(s.timestamp);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
      for (const [k, samples] of groups) {
        const tn = +k.split(':')[0];
        const track = tn === videoTrack.number ? videoTrack : activeAudio;
        const buf = tn === videoTrack.number ? vbuf : abuf;
        if (samples.length >= (track.type === 'video' ? 24 : 43) || samples.at(-1).timestamp - samples[0].timestamp >= 1) {
          const batch = samples.splice(0);
          queue.push({ buf, data: fragment(track, batch, batch[0].timestamp * 90000) });
          appendNext();
        }
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
      generation++;
      if (abuf) ms.removeSourceBuffer(abuf);
      abuf = ms.addSourceBuffer(`audio/mp4; codecs="${codecString(t)}"`);
      abuf.addEventListener('updateend', appendNext);
      abuf.appendBuffer(initSegment(t));
      pump(generation, videoEl.currentTime);
    },
    duration: () => demuxer.durationSec(),
    dispose() {
      generation++;
      videoEl.pause();
      URL.revokeObjectURL(videoEl.src);
      videoEl.removeAttribute('src');
    },
  };
}
