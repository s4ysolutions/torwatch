// statusBar view: mono status line with busy hook (clone of yt-subtitles #status).
// No adapter/fetch use. Reads state via a passed subscribe function (or emitter).
//
// render(container, subscribeTo) => disposeFn
// Also aliased as `render`. Single-arg `statusBar(subscribeTo)` builds the node
// without a container and returns it (caller appends; node.dispose() to unbind).

function isBusy(phase) {
  return phase === 'fetching' || phase === 'loading' || phase === 'waiting' || String(phase ?? '').startsWith('fetching');
}

function textFor(s) {
  if (!s) return '';
  if (s.phase === 'error') return s.error || 'Error';
  if (s.phase === 'idle') return '';
  if (s.phase === 'waiting') return 'Waiting for peers…';
  if (isBusy(s.phase)) return 'Fetching torrent…';
  if (s.phase === 'ready') return 'Ready';
  if (s.phase === 'playing') return '';
  return '';
}

function paint(node, s) {
  const t = textFor(s);
  node.textContent = t;
  node.classList.toggle('busy', isBusy(s?.phase));
  node.style.display = t ? '' : 'none';
}

function isEmitter(x) {
  return x && typeof x.subscribe === 'function' && typeof x.get === 'function';
}

function isContainer(x) {
  return x && (x.nodeType === 1 || typeof x.appendChild === 'function');
}

export function statusBar(containerOrSubscribe, maybeSubscribe) {
  let container = null;
  let subscribeTo;
  if (maybeSubscribe !== undefined) {
    container = containerOrSubscribe;
    subscribeTo = maybeSubscribe;
  } else if (isContainer(containerOrSubscribe)) {
    container = containerOrSubscribe;
    subscribeTo = undefined;
  } else {
    subscribeTo = containerOrSubscribe;
  }

  const node = document.createElement('div');
  node.id = 'status';
  node.classList.add('status');
  if (container) container.appendChild(node);

  let off = () => {};
  if (typeof subscribeTo === 'function') {
    paint(node, { phase: 'idle' });
    off = subscribeTo((v) => paint(node, v)) || off;
  } else if (isEmitter(subscribeTo)) {
    paint(node, subscribeTo.get());
    off = subscribeTo.subscribe((v) => paint(node, v));
  } else {
    paint(node, { phase: 'idle' });
  }

  const dispose = () => {
    try { off(); } catch {}
    try {
      if (container && typeof container.removeChild === 'function' && node.parentNode === container) {
        container.removeChild(node);
      } else if (typeof node.remove === 'function') {
        node.remove();
      } else if (container && typeof container.removeChild === 'function') {
        try { container.removeChild(node); } catch {}
      }
    } catch {}
  };
  if (!container) node.dispose = dispose;
  return container ? dispose : node;
}

export const render = statusBar;
export default statusBar;
