export function backendAdapter(fetchImpl = fetch) {
  const json = async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };
  return {
    addMagnet: (magnet) => fetchImpl('/api/magnets', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ magnet }) }).then(json),
    getMagnet: (id) => fetchImpl(`/api/magnets/${id}`).then(json),
    async fetchRange(id, index, start, end) {
      const r = await fetchImpl(`/api/magnets/${id}/files/${index}`, { headers: { Range: `bytes=${start}-${end}` } });
      if (!r.ok && r.status !== 206) throw new Error('range fetch ' + r.status);
      return new Uint8Array(await r.arrayBuffer());
    },
    deleteMagnet: (id) => fetchImpl(`/api/magnets/${id}`, { method: 'DELETE' }),
    searchSubs: (q) => fetchImpl(`/api/opensubs?query=${encodeURIComponent(q)}`).then(json),
  };
}
