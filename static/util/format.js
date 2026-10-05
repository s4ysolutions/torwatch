// Human-readable byte count: 950 KB, 12.3 MB, 1.42 GB.
export function formatBytes(n) {
  if (n < 1 << 20) return `${Math.round(n / 1024)} KB`;
  if (n < 1 << 30) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${(n / (1 << 30)).toFixed(2)} GB`;
}
