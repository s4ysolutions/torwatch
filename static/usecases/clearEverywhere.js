import { cacheSize, clearCache } from './cacheFile.js';

// Clear every place torrent data is kept: this browser's OPFS cache, the
// in-memory WebTorrent client (browser engine), and the server's downloads.
// Each step runs even if another fails; the result says what happened:
// { localBytes, browserTorrents, serverTorrents, serverError }.
export async function clearEverywhere({ opfs, server, browser }) {
  const result = { localBytes: 0, browserTorrents: 0, serverTorrents: 0, serverError: null };
  result.localBytes = await cacheSize(opfs).catch(() => 0);
  await clearCache(opfs);
  if (browser && typeof browser.clearAll === 'function') {
    result.browserTorrents = await browser.clearAll().catch(() => 0);
  }
  if (server && typeof server.clearServerCache === 'function') {
    try {
      result.serverTorrents = (await server.clearServerCache())?.removed ?? 0;
    } catch (e) {
      result.serverError = e?.message ?? String(e);
    }
  }
  return result;
}

export function describeClear(r, formatBytes) {
  const parts = [`local ${formatBytes(r.localBytes)}`];
  if (r.browserTorrents) parts.push(`${r.browserTorrents} in-browser torrent(s)`);
  parts.push(r.serverError ? `server not cleared (${r.serverError})` : `${r.serverTorrents} server torrent(s)`);
  return `Cleared: ${parts.join(', ')}`;
}
