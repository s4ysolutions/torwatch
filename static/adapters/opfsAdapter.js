// opfsAdapter(root?) — chunk cache for torrent pieces, one file per magnet id.
//
// Memory fallback semantics (root == null, or root unusable): files keep a
// sparse list of {offset, data} writes, so write() is O(chunk) — no
// read-modify-write of the whole buffer per chunk (O(n²)). Reads overlay
// the writes in order (last write wins) over zero-fill, so sparse gaps
// read as 0x00. read(id, start, end) uses inclusive bounds, clips end to
// size, and returns null on miss (unknown id) or when start is past EOF.
//
// OPFS mode (root = await navigator.storage.getDirectory()): same semantics
// via positional writes — SyncAccessHandle where available (worker), else a
// seekable FileSystemWritableFileStream, else read-modify-write fallback.
// Callers must pass null when OPFS is unavailable
// (no navigator.storage?.getDirectory) — factory never throws.

function memoryFiles() {
  const files = new Map(); // id -> { size, chunks: [{offset, data}] }
  const entry = (id) => {
    let e = files.get(id);
    if (!e) {
      e = { size: 0, chunks: [] };
      files.set(id, e);
    }
    return e;
  };
  return {
    async write(id, offset, chunk) {
      const e = entry(id);
      e.chunks.push({ offset, data: chunk.slice() }); // copy: caller may reuse
      const end = offset + chunk.length;
      if (end > e.size) e.size = end;
    },
    async read(id, start, end) {
      const e = files.get(id);
      if (!e || start >= e.size) return null;
      const stop = Math.min(end + 1, e.size);
      const out = new Uint8Array(stop - start); // zero-filled → sparse gaps 0x00
      for (const { offset, data } of e.chunks) {
        const from = Math.max(offset, start);
        const to = Math.min(offset + data.length, stop);
        if (from < to) out.set(data.subarray(from - offset, to - offset), from - start);
      }
      return out; // fresh array every call
    },
    async stat(id) {
      const e = files.get(id);
      return e ? { size: e.size } : null;
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
      // Worker path: positional write without reading the file back.
      if (typeof h.createSyncAccessHandle === 'function') {
        let sh = null;
        try {
          sh = await h.createSyncAccessHandle();
        } catch {
          sh = null;
        }
        if (sh) {
          try {
            sh.write(chunk, { at: offset });
            if (typeof sh.flush === 'function') sh.flush();
          } finally {
            sh.close();
          }
          return;
        }
      }
      // Main-thread path: seekable writable stream, positional write.
      let w = null;
      try {
        w = await h.createWritable();
      } catch {
        w = null;
      }
      if (w && typeof w.seek === 'function') {
        try {
          await w.seek(offset);
          await w.write(chunk);
        } finally {
          await w.close();
        }
        return;
      }
      if (w) {
        try {
          await w.close();
        } catch {}
      }
      // Fallback (fake/testing handles): read-modify-write.
      const cur = new Uint8Array(await (await h.getFile()).arrayBuffer());
      const next = new Uint8Array(Math.max(cur.length, offset + chunk.length));
      next.set(cur, 0);
      next.set(chunk, offset);
      const fw = await h.createWritable();
      try {
        await fw.write(next);
      } finally {
        await fw.close();
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
