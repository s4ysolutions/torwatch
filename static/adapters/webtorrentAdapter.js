export const PINNED_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.fastcast.nz',
];

const norm = (s) => String(s).toLowerCase();

async function swController() {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;
    return await navigator.serviceWorker.ready;
  } catch { return undefined; }
}

function mapFiles(torrent) {
  return (torrent.files ?? []).map((f, i) => ({
    index: i,
    path: f.path ?? f.name ?? `file-${i}`,
    size: f.length ?? f.size ?? 0,
  }));
}

export function webtorrentAdapter({ clientFactory, searchSubs, announceList = PINNED_TRACKERS } = {}) {
  let client = null;
  const errors = new Map(); // id -> message
  const hooked = new Set(); // lowercased ids with an 'error' listener attached
  const hookErrors = (t, id) => {
    if (hooked.has(id)) return;
    hooked.add(id);
    t.on('error', (e) => errors.set(id, e?.message ?? String(e)));
  };
  const ensureClient = () => {
    if (!client) {
      client = typeof clientFactory === 'function'
        ? clientFactory()
        : new globalThis.WebTorrent();
    }
    return client;
  };
  const withTorrent = (id) => ensureClient().get(norm(id));
  return {
    async addMagnet(magnet) {
      const c = ensureClient();
      const t = c.add(magnet, { announce: [...announceList] });
      const id = norm(t.infoHash);
      errors.delete(id);
      hookErrors(t, id);
      return { id };
    },
    async addTorrentFile(data) {
      const c = ensureClient();
      const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
      const t = c.add(buf, { announce: [...announceList] });
      const id = norm(t.infoHash);
      errors.delete(id);
      hookErrors(t, id);
      return { id };
    },
    async getMagnet(id) {
      const nid = norm(id);
      const t = withTorrent(nid);
      if (!t) throw new Error('unknown magnet ' + nid);
      if (errors.has(nid)) return { id: nid, name: t.name ?? '', state: 'error', error: errors.get(nid), files: [] };
      if (t.ready || (t.files ?? []).length) {
        return { id: nid, name: t.name ?? '', state: 'ready', files: mapFiles(t) };
      }
      return { id: nid, name: t.name ?? '', state: 'fetching-meta', files: [] };
    },
    async deleteMagnet(id) {
      const nid = norm(id);
      errors.delete(nid);
      hooked.delete(nid);
      const c = ensureClient();
      try { c.remove(nid, { destroyStore: true }); } catch {}
    },
    searchSubs: typeof searchSubs === 'function' ? searchSubs : async () => { throw new Error('search not configured'); },
    async fetchRange(id, index, start, end) {
      const t = withTorrent(id);
      if (!t) throw new Error('unknown magnet ' + id);
      const f = (t.files ?? [])[index];
      if (!f) throw new Error('bad file index ' + index);
      const stream = f.createReadStream({ start, end });
      const chunks = [];
      for await (const c of stream) chunks.push(c instanceof Uint8Array ? c : new Uint8Array(c));
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    },
    async attachNative(id, index, videoEl) {
      const c = ensureClient();
      const controller = await swController();
      try { c._twServer = c._twServer ?? c.createServer(controller ? { controller } : undefined); } catch { /* fall through to clear error below */ }
      if (!c._twServer) throw new Error('native playback unavailable (stream server failed)');
      const t = withTorrent(id);
      const f = (t?.files ?? [])[index];
      if (!f || typeof f.streamTo !== 'function') throw new Error('native playback unavailable');
      f.streamTo(videoEl);
      return () => {
        try { videoEl.pause(); } catch {}
        try { videoEl.removeAttribute('src'); videoEl.load(); } catch {}
      };
    },
    // No URL: the file must be assembled into a Blob (downloadFile) — only
    // on explicit user request, it pulls the whole file into memory.
    downloadUrl: () => null,
    async downloadFile(id, index) {
      const t = withTorrent(id);
      const f = (t?.files ?? [])[index];
      if (!f) throw new Error('bad file index ' + index);
      const name = String(f.path ?? f.name ?? `file-${index}`).split('/').pop();
      if (typeof f.blob === 'function') {
        const b = await f.blob();
        return { name, blob: b ?? undefined };
      }
      if (typeof f.arrayBuffer === 'function') {
        const ab = await f.arrayBuffer();
        return { name, blob: new Blob([ab]) };
      }
      throw new Error('download unavailable');
    },
  };
}
