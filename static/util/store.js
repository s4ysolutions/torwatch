export function ns(prefix) {
  const k = key => `${prefix}.${key}`;
  return {
    get(key, fallback = null) {
      try { const raw = localStorage.getItem(k(key)); return raw == null ? fallback : JSON.parse(raw); }
      catch { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem(k(key), JSON.stringify(val)); } catch {}
    },
  };
}

export const store = { ns };
