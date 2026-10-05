export function backendAdapter(fetchImpl = fetch) {
  const json = async (r) => {
    let j = null;
    try { j = await r.json(); } catch { /* non-JSON body (e.g. plain-text error) */ }
    if (!r.ok) throw new Error((j && j.error) || `request failed (${r.status})`);
    return j;
  };
  return {
    addMagnet: (magnet) => fetchImpl('/api/magnets', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ magnet }) }).then(json),
    addTorrentFile: (data) => fetchImpl('/api/torrents', { method: 'POST', body: data }).then(json),
    getMagnet: (id) => fetchImpl(`/api/magnets/${id}`).then(json),
    async fetchRange(id, index, start, end) {
      const r = await fetchImpl(`/api/magnets/${id}/files/${index}`, { headers: { Range: `bytes=${start}-${end}` } });
      if (!r.ok && r.status !== 206) throw new Error('range fetch ' + r.status);
      return new Uint8Array(await r.arrayBuffer());
    },
    deleteMagnet: (id) => fetchImpl(`/api/magnets/${id}`, { method: 'DELETE' }),
    searchSubs: (q) => fetchImpl(`/api/opensubs?query=${encodeURIComponent(q)}`).then(json),
    async attachNative(id, index, videoEl) {
      videoEl.src = `/api/magnets/${id}/files/${index}`;
      return () => {
        try { videoEl.removeAttribute('src'); videoEl.load(); } catch {}
      };
    },
    // Direct URL: downloading needs no preparation on this engine.
    downloadUrl: (id, index) => `/api/magnets/${id}/files/${index}`,
    async downloadFile(id, index) {
      let name = `file-${index}`;
      try {
        const info = await this.getMagnet(id);
        const f = (info.files ?? []).find(x => x.index === index);
        if (f?.path) name = String(f.path).split('/').pop() || name;
      } catch {}
      return { name, url: `/api/magnets/${id}/files/${index}` };
    },
  };
}
