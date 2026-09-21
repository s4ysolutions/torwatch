export const PINNED_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.fastcast.nz',
];

const norm = (s) => String(s).toLowerCase();

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
      t.on('error', (e) => errors.set(id, e?.message ?? String(e)));
      return { id };
    },
    async addTorrentFile(data) {
      const c = ensureClient();
      const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
      const t = c.add(buf, { announce: [...announceList] });
      const id = norm(t.infoHash);
      t.on('error', (e) => errors.set(id, e?.message ?? String(e)));
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
      try { ensureClient().remove(norm(id), { destroyStore: true }); } catch {}
    },
    searchSubs: typeof searchSubs === 'function' ? searchSubs : async () => { throw new Error('search not configured'); },
    // fetchRange / attachNative / downloadFile arrive in Task 4.
  };
}
