// Pull-based byte window over fetchRange(start, end) => Promise<Uint8Array>.
// fetchRange uses inclusive end.
//
// Bounded sliding window: only the most recent maxBytes are retained.
// `ensure(off,len)` fetches the missing tail and evicts from the front;
// a backward access (off < winStart) or a forward jump past the window end
// resets the window at off via re-fetch. A single read larger than maxBytes
// grows the window past the cap (soft cap — the requested range is always
// fully retained), so callers should keep reads small.
//
// CORRECTNESS: `buf` is REPLACED on grow/evict/reset. Never hold a
// reference across `await ensure()` — always re-read `stream.buf` /
// `stream.winStart` afterwards, and treat `read()`/`absSlice()` results as
// fresh copies (Uint8Array.slice copies).

const DEFAULT_CHUNK = 256 * 1024;
const DEFAULT_MAX = 8 * 1024 * 1024;

export class ByteStream {
  constructor(fetchRange, chunkSize = DEFAULT_CHUNK, maxBytes = DEFAULT_MAX) {
    this.fetch = fetchRange;
    this.chunkSize = chunkSize;
    this.maxBytes = maxBytes;
    this.buf = new Uint8Array(0); // window contents: file bytes [winStart, winStart+len)
    this.winStart = 0; // absolute file offset of buf[0]
    this.eof = false;
  }

  get length() {
    return this.buf.length;
  }

  get winEnd() {
    return this.winStart + this.buf.length;
  }

  // Fresh copy of absolute range [off, off+len). Caller must ensure() first.
  absSlice(off, len) {
    const rel = off - this.winStart;
    return this.buf.slice(rel, rel + len);
  }

  reset(off) {
    this.winStart = off;
    this.buf = new Uint8Array(0);
    this.eof = false;
  }

  evictFront() {
    // Drop bytes before the last maxBytes, keeping the window bounded.
    // Called only to bound a window whose needed range already starts at
    // or after winStart; bytes of the pending request are never dropped
    // (see ensure: evict budget is capped by off - winStart).
    const excess = this.buf.length - this.maxBytes;
    if (excess > 0) {
      this.buf = this.buf.slice(excess);
      this.winStart += excess;
    }
  }

  async ensure(off, len) {
    if (off < 0 || len < 0) throw new Error(`bad range ${off}+${len}`);
    if (len === 0) return;
    if (off < this.winStart || off > this.winEnd) this.reset(off);
    const need = off + len;
    while (this.winEnd < need && !this.eof) {
      const from = this.winEnd;
      const to = Math.max(from + this.chunkSize - 1, need - 1);
      const chunk = await this.fetch(from, to);
      if (!chunk || chunk.length === 0) {
        this.eof = true;
        break;
      }
      const grown = new Uint8Array(this.buf.length + chunk.length);
      grown.set(this.buf, 0);
      grown.set(chunk, this.buf.length);
      this.buf = grown;
      if (chunk.length < to - from + 1) this.eof = true;
      // Bound the window but never evict bytes at/after off (the pending
      // request stays fully retained even when len > maxBytes).
      const evictable = Math.min(this.buf.length - this.maxBytes, off - this.winStart);
      if (evictable > 0) {
        this.buf = this.buf.slice(evictable);
        this.winStart += evictable;
      }
    }
    const rel = off - this.winStart;
    if (rel < 0 || this.buf.length < rel + len) throw new Error(`EOF at offset ${off} len ${len}`);
  }

  async read(off, len) {
    await this.ensure(off, len);
    return this.absSlice(off, len); // fresh copy — safe to hold
  }
}
