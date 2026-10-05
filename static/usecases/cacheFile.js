import { playerState } from '../domain/playerState.js';
import { store } from '../util/store.js';
import { formatBytes } from '../util/format.js';

// Status text for the bytes the player has read since the video opened:
// { cache, network } byte counts; engine names where network bytes came
// from ('server' / 'browser peers'). Cache bytes include re-reads (after a
// seek, an audio switch), network bytes are what was actually downloaded.
export function describeSource({ cache, network }, engine) {
  if (!cache && !network) return null;
  if (!network) return `Playing from local cache (${formatBytes(cache)} read)`;
  const dl = `Downloaded via ${engine}: ${formatBytes(network)}`;
  return cache ? `${dl} · from local cache: ${formatBytes(cache)}` : dl;
}

// Last use per cache key (ms), for pruneCache: { [key]: ms }.
const usage = () => store.ns('torwatch');
function touch(key, now = Date.now()) {
  const used = usage().get('cacheUsed', {});
  used[key] = now;
  usage().set('cacheUsed', used);
}

// Drop cached files unused for ttlMs, then least recently used ones until
// the total fits maxBytes. Returns the removed keys.
export async function pruneCache(opfs, { maxBytes, ttlMs = 7 * 24 * 3600e3, now = Date.now() } = {}) {
  const used = usage().get('cacheUsed', {});
  const entries = [];
  for (const key of await opfs.listIds()) {
    const st = await opfs.stat(key);
    entries.push({ key, bytes: st?.bytes ?? st?.size ?? 0, at: used[key] ?? 0 });
  }
  entries.sort((a, b) => a.at - b.at); // oldest first
  let total = entries.reduce((n, e) => n + e.bytes, 0);
  const removed = [];
  for (const e of entries) {
    if (now - e.at <= ttlMs && !(maxBytes >= 0 && total > maxBytes)) continue;
    await opfs.remove(e.key);
    total -= e.bytes;
    removed.push(e.key);
    delete used[e.key];
  }
  usage().set('cacheUsed', used);
  return removed;
}

// Total bytes cached across all files.
export async function cacheSize(opfs) {
  let n = 0;
  for (const key of await opfs.listIds()) {
    const st = await opfs.stat(key);
    n += st?.bytes ?? st?.size ?? 0;
  }
  return n;
}

export async function clearCache(opfs) {
  for (const key of await opfs.listIds()) await opfs.remove(key);
  usage().set('cacheUsed', {});
}

// Read-through chunk cache over opfsAdapter + backendAdapter.fetchRange.
// Full-coverage hit → bytes; partial → fetch just the gaps, then serve from
// the cache; no cache → network fetch + opfs.write. A write failure
// (e.g. QuotaExceededError) degrades to plain network fetch and records a
// playerState note. Bounds are inclusive on both layers.
// onBytes(source, n), optional: source is 'cache' or 'network' — lets the
// UI say where playback data actually comes from.
export function cachingFetchRange(opfs, adapter, id, index, { onBytes } = {}) {
  const key = `${id}:${index}`;
  let degraded = false;
  const count = (source, n) => {
    try {
      onBytes?.(source, n);
    } catch {}
  };
  touch(key);
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
    count('network', bytes.length);
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
        if (hit) {
          count('cache', hit.length);
          return hit;
        }
        // Partly cached: fetch only the gaps, then assemble from the cache.
        if (typeof opfs.missing === 'function') {
          const gaps = await opfs.missing(key, start, end);
          // Nothing cached in range: one plain fetch (no re-read needed).
          if (gaps.length === 1 && gaps[0][0] === start && gaps[0][1] >= end + 1) {
            return await fetchAndStore(start, end);
          }
          let fetched = 0;
          for (const [from, to] of gaps) {
            fetched += (await fetchAndStore(from, to - 1)).length;
            if (degraded) break;
          }
          if (!degraded) {
            const full = await opfs.read(key, start, end);
            if (full) {
              count('cache', Math.max(0, full.length - fetched));
              return full;
            }
          }
        }
      } catch {
        // cache read failure → fall through to a plain network fetch
      }
    }
    return fetchAndStore(start, end);
  };
}
