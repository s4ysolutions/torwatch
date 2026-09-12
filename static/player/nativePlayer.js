export function createNativePlayer(videoEl, srcUrl) {
  videoEl.src = srcUrl;
  return {
    play: () => videoEl.play(),
    pause: () => videoEl.pause(),
    seek: (s) => { videoEl.currentTime = s; },
    dispose: () => { videoEl.removeAttribute('src'); videoEl.load(); },
  };
}
