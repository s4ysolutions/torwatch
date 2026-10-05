import { cacheSize, clearCache } from './cacheFile.js';

// Clear every place torrent data is kept: the WebTorrent client (browser
// engine) and its pieces in OPFS, this app's OPFS cache, and the server's
// downloads. storageRoot (the OPFS root) is where WebTorrent stores pieces,
// also those of earlier sessions; every entry there except keepName (the
// cache directory, cleared through opfs) is removed. Each step runs even if
// another fails; the result says what happened:
// { localBytes, browserTorrents, browserEntries, serverTorrents, serverError }.
export async function clearEverywhere({ opfs, server, browser, storageRoot = null, keepName = null }) {
  const result = { localBytes: 0, browserTorrents: 0, browserEntries: 0, serverTorrents: 0, serverError: null };
  // Stop WebTorrent first: it holds open handles into its OPFS files.
  if (browser && typeof browser.clearAll === 'function') {
    result.browserTorrents = await browser.clearAll().catch(() => 0);
  }
  if (storageRoot) {
    for await (const name of storageRoot.keys()) {
      if (name === keepName) continue;
      try {
        await storageRoot.removeEntry(name, { recursive: true });
        result.browserEntries++;
      } catch {}
    }
  }
  result.localBytes = await cacheSize(opfs).catch(() => 0);
  await clearCache(opfs);
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
  if (r.browserTorrents || r.browserEntries) parts.push('browser-engine data');
  parts.push(r.serverError ? `server not cleared (${r.serverError})` : `${r.serverTorrents} server torrent(s)`);
  return `Cleared: ${parts.join(', ')}`;
}
