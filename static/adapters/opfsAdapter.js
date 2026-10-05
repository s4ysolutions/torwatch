// opfsAdapter(root?) — range cache for torrent file bytes, keyed by id.
//
// Every write is stored as its own immutable chunk ({offset, bytes}); the
// set of chunks is the coverage map. read(id, start, end) (inclusive end)
// returns bytes only when [start, end] is fully covered — clipped to the
// file end once setEof() has recorded it — and null otherwise, so a gap
// is always a miss, never zero-filled data.
//
// OPFS mode (root = await navigator.storage.getDirectory()): one directory
// per id, one file per chunk named by its offset, plus an `eof` file. No
// file is ever rewritten (no truncating writable, no read-modify-write);
// reads slice only the chunk files they need. missing() lists the gaps so
// callers fetch only what isn't cached. The coverage index is
// rebuilt from the directory listing after a reload.
// Memory mode (root == null): same semantics, chunks kept in memory.

const EOF_NAME = 'eof';

// index: { chunks: [{offset, length, read(from, to) => Promise<Uint8Array>}]
// sorted by offset, eof: number|null }.
function covered(index, start, stop) {
  const pieces = [];
  let pos = start;
  while (pos < stop) {
    let best = null;
    for (const c of index.chunks) {
      if (c.offset > pos) break;
      const cEnd = c.offset + c.length;
      if (cEnd > pos && (!best || cEnd > best.offset + best.length)) best = c;
    }
    if (!best) return null;
    const to = Math.min(best.offset + best.length, stop);
    pieces.push({ c: best, from: pos, to });
    pos = to;
  }
  return pieces;
}

// Uncovered [from, to) ranges of inclusive [start, end], clipped to a known
// eof; the last gap is open-ended (to = end + 1) while eof is unknown.
function gapsOf(index, start, end) {
  const stop = Math.min(end + 1, index?.eof ?? Infinity);
  if (!index) return start < stop ? [[start, stop]] : [];
  const gaps = [];
  let pos = start;
  for (const c of index.chunks) {
    if (pos >= stop) break;
    const cEnd = c.offset + c.length;
    if (cEnd <= pos) continue;
    if (c.offset > pos) gaps.push([pos, Math.min(c.offset, stop)]);
    pos = Math.max(pos, cEnd);
  }
  if (pos < stop) gaps.push([pos, stop]);
  return gaps;
}

async function readIndex(index, start, end) {
  const stop = Math.min(end + 1, index.eof ?? Infinity);
  if (start >= stop) return index.eof != null && start >= index.eof ? new Uint8Array(0) : null;
  const pieces = covered(index, start, stop);
  if (!pieces) return null;
  const out = new Uint8Array(stop - start);
  for (const { c, from, to } of pieces) {
    out.set(await c.read(from - c.offset, to - c.offset), from - start);
  }
  return out;
}

function insertChunk(index, chunk) {
  let i = index.chunks.length;
  while (i > 0 && index.chunks[i - 1].offset > chunk.offset) i--;
  index.chunks.splice(i, 0, chunk);
}

// Bytes actually stored (chunks may overlap).
function storedBytes(index) {
  let n = 0;
  for (const c of index.chunks) n += c.length;
  return n;
}

function maxEnd(index) {
  let size = 0;
  for (const c of index.chunks) size = Math.max(size, c.offset + c.length);
  return index.eof ?? size;
}

function memoryFiles() {
  const files = new Map(); // id -> index
  const entry = (id) => {
    if (!files.has(id)) files.set(id, { chunks: [], eof: null });
    return files.get(id);
  };
  return {
    async write(id, offset, chunk) {
      const index = entry(id);
      if (!chunk.length || covered(index, offset, offset + chunk.length)) return;
      const data = chunk.slice(); // copy: caller may reuse
      insertChunk(index, { offset, length: data.length, read: async (a, b) => data.slice(a, b) });
    },
    async setEof(id, size) {
      entry(id).eof = size;
    },
    async read(id, start, end) {
      const index = files.get(id);
      return index ? readIndex(index, start, end) : null;
    },
    async missing(id, start, end) {
      return gapsOf(files.get(id), start, end);
    },
    async stat(id) {
      const index = files.get(id);
      return index ? { size: maxEnd(index), bytes: storedBytes(index) } : null;
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
  const dirName = (id) => encodeURIComponent(id);
  const noEntry = (e) => e?.name === 'NotFoundError';
  const indexes = new Map(); // id -> Promise<index|null>

  const chunkOf = (handle, offset, length) => ({
    offset,
    length,
    read: async (a, b) => new Uint8Array(await (await handle.getFile()).slice(a, b).arrayBuffer()),
  });

  async function dir(id, create) {
    try {
      return await root.getDirectoryHandle(dirName(id), { create });
    } catch (e) {
      if (noEntry(e) || e?.name === 'TypeMismatchError') return null;
      throw e;
    }
  }

  async function loadIndex(id, create) {
    const d = await dir(id, create);
    if (!d) return null;
    const index = { dir: d, chunks: [], eof: null };
    for await (const [name, handle] of d.entries()) {
      if (handle.kind !== 'file') continue;
      if (name === EOF_NAME) {
        const n = Number(await (await handle.getFile()).text());
        if (Number.isFinite(n)) index.eof = n;
        continue;
      }
      const offset = Number(name);
      if (!Number.isInteger(offset)) continue;
      const size = (await handle.getFile()).size;
      if (size > 0) insertChunk(index, chunkOf(handle, offset, size));
    }
    return index;
  }

  // One cached load per id (concurrent callers share it); a cached miss
  // (null) is reloaded when a writer needs the directory created.
  async function index(id, create) {
    let ix = await indexes.get(id);
    if (ix === undefined || (ix === null && create)) {
      const p = loadIndex(id, create);
      indexes.set(id, p);
      try {
        ix = await p;
      } catch (e) {
        indexes.delete(id);
        throw e;
      }
    }
    return ix;
  }

  async function writeFile(d, name, data) {
    const h = await d.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    try {
      await w.write(data);
    } finally {
      await w.close();
    }
    return h;
  }

  return {
    async write(id, offset, chunk) {
      if (!chunk.length) return;
      const ix = await index(id, true);
      if (covered(ix, offset, offset + chunk.length)) return;
      const h = await writeFile(ix.dir, String(offset), chunk);
      insertChunk(ix, chunkOf(h, offset, chunk.length));
    },
    async setEof(id, size) {
      const ix = await index(id, true);
      if (ix.eof === size) return;
      await writeFile(ix.dir, EOF_NAME, new TextEncoder().encode(String(size)));
      ix.eof = size;
    },
    async read(id, start, end) {
      const ix = await index(id, false);
      return ix ? readIndex(ix, start, end) : null;
    },
    async missing(id, start, end) {
      return gapsOf(await index(id, false), start, end);
    },
    async stat(id) {
      const ix = await index(id, false);
      return ix ? { size: maxEnd(ix), bytes: storedBytes(ix) } : null;
    },
    async remove(id) {
      indexes.delete(id);
      try {
        await root.removeEntry(dirName(id), { recursive: true });
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
  if (root && typeof root.getDirectoryHandle === 'function') return opfsFiles(root);
  return memoryFiles();
}
