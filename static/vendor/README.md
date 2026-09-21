# Vendored WebTorrent

- Version: `2.8.5` (pinned, see `VERSION`)
- Source URL: `https://cdn.jsdelivr.net/npm/webtorrent@2.8.5/dist/webtorrent.min.js`
- License: MIT (WebTorrent is MIT-licensed; original LICENSE ships upstream)
- Provides: `window.WebTorrent` global (UMD bundle) for the torrent adapters.

## Re-vendor

```bash
VER="2.8.5"
curl -fsSL "https://cdn.jsdelivr.net/npm/webtorrent@${VER}/dist/webtorrent.min.js" -o static/vendor/webtorrent.min.js
printf '/*! webtorrent@%s (MIT) vendored, see static/vendor/README.md */\n' "$VER" | cat - static/vendor/webtorrent.min.js > /tmp/wt.js && mv /tmp/wt.js static/vendor/webtorrent.min.js
printf '%s\n' "$VER" > static/vendor/VERSION
curl -fsSL "https://cdn.jsdelivr.net/npm/webtorrent@${VER}/LICENSE" -o static/vendor/LICENSE
```
