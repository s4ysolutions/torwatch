export function createNativePlayer(videoEl, attach) {
  let cleanup = null;
  let disposed = false;
  const ready = Promise.resolve()
    .then(() => {
      if (disposed) return null;
      return attach(videoEl);
    })
    .then((c) => {
      if (disposed) {
        try { if (typeof c === 'function') c(); } catch {}
        return null;
      }
      cleanup = c;
      return null;
    });
  return {
    ready,
    play: () => videoEl.play(),
    pause: () => videoEl.pause(),
    seek: (s) => { videoEl.currentTime = s; },
    dispose: () => {
      disposed = true;
      try { videoEl.pause(); } catch {}
      ready.then(() => {
        try { if (typeof cleanup === 'function') cleanup(); } catch {}
      }).catch(() => {});
      try { videoEl.removeAttribute('src'); videoEl.load(); } catch {}
    },
  };
}
