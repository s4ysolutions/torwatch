// opfsAdapter(root?) — chunk cache for torrent pieces, one file per magnet id.
//
// Memory fallback semantics (root == null, or root unusable): files live in a
// Map<id, Uint8Array>. write() grows the buffer with zero-fill, so sparse
// writes leave 0x00 gaps; overlapping writes overwrite (last write wins).
// read(id, start, end) uses inclusive bounds, clips end to size, and returns
// null on miss (unknown id) or when start is past EOF.
//
// OPFS mode (root = await navigator.storage.getDirectory()): same semantics
// via read-modify-write (getFile + createWritable), so no SyncAccessHandle
// (worker-only) is needed. Callers must pass null when OPFS is unavailable
// (no navigator.storage?.getDirectory) — factory never throws.

function memoryFiles() {
  const files = new Map(); // id -> Uint8Array
  return {
    async write(id, offset, chunk) {
      const cur = files.get(id) ?? new Uint8Array(0);
      const size = Math.max(cur.length, offset + chunk.length);
      const next = new Uint8Array(size); // zero-filled → sparse gaps read as 0x00
      next.set(cur, 0);
      next.set(chunk, offset); // overlap: last write wins
      files.set(id, next);
    },
    async read(id, start, end) {
      const cur = files.get(id);
      if (!cur || start >= cur.length) return null;
      return cur.slice(start, Math.min(end + 1, cur.length));
    },
    async stat(id) {
      const cur = files.get(id);
      return cur ? { size: cur.length } : null;
    },
    async remove(id) {
      files.delete(id);
    },
    async listIds() {
      return [...files.keys()];
    },
  };
}

function opfsFiles(root) {
  const name = (id) => encodeURIComponent(id);
  const noEntry = (e) => e?.name === 'NotFoundError';
  return {
    async write(id, offset, chunk) {
      const h = await root.getFileHandle(name(id), { create: true });
      const cur = new Uint8Array(await (await h.getFile()).arrayBuffer());
      const next = new Uint8Array(Math.max(cur.length, offset + chunk.length));
      next.set(cur, 0);
      next.set(chunk, offset);
      const w = await h.createWritable();
      try {
        await w.write(next);
      } finally {
        await w.close();
      }
    },
    async read(id, start, end) {
      let h;
      try {
        h = await root.getFileHandle(name(id));
      } catch (e) {
        if (noEntry(e)) return null;
        throw e;
      }
      const cur = new Uint8Array(await (await h.getFile()).arrayBuffer());
      if (start >= cur.length) return null;
      return cur.slice(start, Math.min(end + 1, cur.length));
    },
    async stat(id) {
      try {
        const f = await (await root.getFileHandle(name(id))).getFile();
        return { size: f.size };
      } catch (e) {
        if (noEntry(e)) return null;
        throw e;
      }
    },
    async remove(id) {
      try {
        await root.removeEntry(name(id));
      } catch (e) {
        if (!noEntry(e)) throw e;
      }
    },
    async listIds() {
      const ids = [];
      for await (const key of root.keys()) ids.push(decodeURIComponent(key));
      return ids;
    },
  };
}

export function opfsAdapter(root) {
  if (root && typeof root.getFileHandle === 'function') return opfsFiles(root);
  return memoryFiles();
}
