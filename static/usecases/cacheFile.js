import { playerState } from '../domain/playerState.js';

// Read-through chunk cache over opfsAdapter + backendAdapter.fetchRange.
// Full-coverage hit → bytes; partial → fetch just the gaps, then serve from
// the cache; no cache → network fetch + opfs.write. A write failure
// (e.g. QuotaExceededError) degrades to plain network fetch and records a
// playerState note. Bounds are inclusive on both layers.
export function cachingFetchRange(opfs, adapter, id, index) {
  const key = `${id}:${index}`;
  let degraded = false;
  const degrade = () => {
    degraded = true;
    try {
      playerState.set({ ...playerState.get(), note: 'cache unavailable' });
    } catch {}
  };
  // Fetch [s, e] (inclusive) from the network and cache it; a short read is
  // the end of the file. Returns the bytes.
  const fetchAndStore = async (s, e) => {
    const bytes = await adapter.fetchRange(id, index, s, e);
    if (!degraded) {
      try {
        await opfs.write(key, s, bytes);
        if (bytes.length < e - s + 1 && typeof opfs.setEof === 'function') {
          await opfs.setEof(key, s + bytes.length);
        }
      } catch {
        degrade();
      }
    }
    return bytes;
  };
  return async (start, end) => {
    if (!degraded) {
      try {
        const hit = await opfs.read(key, start, end);
        if (hit) return hit;
        // Partly cached: fetch only the gaps, then assemble from the cache.
        if (typeof opfs.missing === 'function') {
          const gaps = await opfs.missing(key, start, end);
          // Nothing cached in range: one plain fetch (no re-read needed).
          if (gaps.length === 1 && gaps[0][0] === start && gaps[0][1] >= end + 1) {
            return await fetchAndStore(start, end);
          }
          for (const [from, to] of gaps) {
            await fetchAndStore(from, to - 1);
            if (degraded) break;
          }
          if (!degraded) {
            const full = await opfs.read(key, start, end);
            if (full) return full;
          }
        }
      } catch {
        // cache read failure → fall through to a plain network fetch
      }
    }
    return fetchAndStore(start, end);
  };
}
