// inputCard view: magnet input + Watch button, .torrent file input, subtitle
// file input, recent-magnets dropdown from store history.
// No adapter/fetch use. Callbacks only:
//
// inputCardView(container, { onMagnet, onTorrentFile, onSubsFile }) => disposeFn
// inputCardView({ onMagnet, onTorrentFile, onSubsFile }) => element (caller appends)

import { el } from '../util/dom.js';
import { store } from '../util/store.js';
import { playerState } from '../domain/playerState.js';

function isContainer(x) {
  return x && (x.nodeType === 1 || typeof x.appendChild === 'function');
}

export function inputCardView(containerOrProps, maybeProps) {
  let container = null;
  let props;
  if (maybeProps !== undefined) {
    container = containerOrProps;
    props = maybeProps ?? {};
  } else if (isContainer(containerOrProps)) {
    container = containerOrProps;
    props = {};
  } else {
    props = containerOrProps ?? {};
  }
  const { onMagnet, onTorrentFile, onSubsFile, onEngine } = props;

  const history = store.ns('torwatch').get('history', []) ?? [];

  const magnetInput = el('input', {
    type: 'text',
    id: 'magnet',
    placeholder: 'magnet:?xt=urn:btih:…',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const recent = el(
    'select',
    { id: 'recent', title: 'Recent magnets' },
    [el('option', { value: '' }, ['Recent…'])].concat(
      history.map((m) => el('option', { value: m }, [m.slice(0, 48)])),
    ),
  );
  const watchBtn = el('button', { type: 'button', id: 'watch' }, ['Watch']);
  const torrentInput = el('input', { type: 'file', id: 'torrentFile', accept: '.torrent' });
  const subsInput = el('input', { type: 'file', id: 'subsFile', accept: '.srt,.vtt' });

  const engines = [['browser', 'Browser (default)'], ['server', 'Server']];
  const currentEngine = store.ns('torwatch').get('engine', 'browser');
  const engineRow = el('div', { class: 'engine-toggle' }, engines.map(([v, label]) =>
    el('label', {}, [
      el('input', { type: 'radio', name: 'engine', value: v, ...(currentEngine === v ? { checked: true } : {}) }),
      label,
    ]),
  ));

  const card = el('section', { class: 'card input-card' }, [
    el('label', { for: 'magnet' }, [
      'Magnet link',
      magnetInput,
    ]),
    recent,
    watchBtn,
    el('label', { for: 'torrentFile' }, ['.torrent file', torrentInput]),
    el('label', { for: 'subsFile' }, ['Subtitles (.srt/.vtt)', subsInput]),
    engineRow,
  ]);

  const submit = () => {
    const m = (magnetInput.value ?? '').trim();
    if (m && typeof onMagnet === 'function') onMagnet(m);
  };
  const onWatchClick = () => submit();
  const onMagnetKey = (e) => {
    if (e.key === 'Enter') submit();
  };
  const onRecentChange = () => {
    if (recent.value) magnetInput.value = recent.value;
  };
  const onTorrentChange = () => {
    const f = torrentInput.files?.[0];
    if (f && typeof onTorrentFile === 'function') onTorrentFile(f);
  };
  const onSubsChange = () => {
    const f = subsInput.files?.[0];
    if (f && typeof onSubsFile === 'function') onSubsFile(f);
  };
  const onEngineChange = (e) => {
    try {
      const ph = playerState.get()?.phase;
      if (ph !== 'idle' && ph !== 'error') return;
    } catch {}
    const v = e?.target?.value;
    if ((v === 'browser' || v === 'server') && typeof onEngine === 'function') onEngine(v);
  };
  const engineRadios = [...engineRow.querySelectorAll('input[name="engine"]')];
  const syncEngineDisabled = (st) => {
    let ph;
    try { ph = st?.phase ?? playerState.get()?.phase; } catch { return; }
    const disabled = ph !== 'idle' && ph !== 'error';
    for (const r of engineRadios) {
      try {
        r.disabled = disabled;
        if (disabled) r.setAttribute('disabled', '');
        else r.removeAttribute('disabled');
      } catch {}
    }
  };
  for (const r of engineRadios) r.addEventListener('change', onEngineChange);
  let unsubEngine = null;
  try {
    syncEngineDisabled(playerState.get());
    unsubEngine = playerState.subscribe(syncEngineDisabled);
  } catch {}

  watchBtn.addEventListener('click', onWatchClick);
  magnetInput.addEventListener('keydown', onMagnetKey);
  recent.addEventListener('change', onRecentChange);
  torrentInput.addEventListener('change', onTorrentChange);
  subsInput.addEventListener('change', onSubsChange);

  if (container) container.appendChild(card);

  const dispose = () => {
    try { if (typeof unsubEngine === 'function') unsubEngine(); } catch {}
    watchBtn.removeEventListener('click', onWatchClick);
    magnetInput.removeEventListener('keydown', onMagnetKey);
    recent.removeEventListener('change', onRecentChange);
    torrentInput.removeEventListener('change', onTorrentChange);
    subsInput.removeEventListener('change', onSubsChange);
    for (const r of engineRadios) r.removeEventListener('change', onEngineChange);
    try {
      if (typeof card.remove === 'function') card.remove();
      else if (container && typeof container.removeChild === 'function') container.removeChild(card);
    } catch {}
  };
  if (!container) card.dispose = dispose;
  return container ? dispose : card;
}

export const render = inputCardView;
export default inputCardView;
