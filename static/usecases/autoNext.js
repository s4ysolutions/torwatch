// Auto-advance to the next episode: when the video ends, count down, then
// fire. Seeking or playing again (the user wants to stay) cancels.
//
// armAutoNext({ video, delaySec, onTick(secLeft), onCancel(), onFire() })
//   => { cancel(), dispose() }
export function armAutoNext({ video, delaySec = 5, onTick = () => {}, onCancel = () => {}, onFire }) {
  let timer = null;
  let left = 0;
  const stop = () => {
    if (timer == null) return false;
    clearInterval(timer);
    timer = null;
    return true;
  };
  const cancel = () => {
    if (stop()) onCancel();
  };
  const onEnded = () => {
    stop();
    left = delaySec;
    onTick(left);
    timer = setInterval(() => {
      left--;
      if (left > 0) return onTick(left);
      stop();
      onFire();
    }, 1000);
  };
  video.addEventListener('ended', onEnded);
  video.addEventListener('seeking', cancel);
  video.addEventListener('play', cancel);
  return {
    cancel,
    dispose() {
      stop();
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('seeking', cancel);
      video.removeEventListener('play', cancel);
    },
  };
}
