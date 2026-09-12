import { playerState } from '../domain/playerState.js';

// Read-through chunk cache over opfsAdapter + backendAdapter.fetchRange.
// OPFS hit → bytes; miss → network fetch + opfs.write. A write failure
// (e.g. QuotaExceededError) degrades to plain network fetch and records a
// playerState note. Bounds are inclusive on both layers.
export function cachingFetchRange(opfs, adapter, id, index) {
  const key = `${id}:${index}`;
  let degraded = false;
  return async (start, end) => {
    if (!degraded) {
      try {
        const hit = await opfs.read(key, start, end);
        if (hit) return hit;
      } catch {
        // read failure → fall through to network
      }
    }
    const bytes = await adapter.fetchRange(id, index, start, end);
    if (!degraded) {
      try {
        await opfs.write(key, start, bytes);
      } catch {
        degraded = true;
        try {
          playerState.set({ ...playerState.get(), note: 'cache unavailable' });
        } catch {}
      }
    }
    return bytes;
  };
}
