// Pull-based byte window over fetchRange(start, end) => Promise<Uint8Array>.
// fetchRange uses inclusive end. Access is sequential: the window grows
// contiguously from 0, fetching ahead in chunks. DOM-free.

const DEFAULT_CHUNK = 256 * 1024;

export class ByteStream {
  constructor(fetchRange, chunkSize = DEFAULT_CHUNK) {
    this.fetch = fetchRange;
    this.chunkSize = chunkSize;
    this.buf = new Uint8Array(0);
    this.eof = false;
  }

  get length() {
    return this.buf.length;
  }

  async ensure(off, len) {
    const need = off + len;
    while (this.buf.length < need && !this.eof) {
      const from = this.buf.length;
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
    }
    if (this.buf.length < need) throw new Error(`EOF at offset ${off} len ${len}`);
  }

  async read(off, len) {
    await this.ensure(off, len);
    return this.buf.slice(off, off + len);
  }
}
