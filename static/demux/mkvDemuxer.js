import {
  readVint,
  readElementHeader,
  ID_SEGMENT,
  ID_INFO,
  ID_TIMESTAMP_SCALE,
  ID_DURATION,
  ID_TRACKS,
  ID_TRACK_ENTRY,
  ID_TRACK_NUMBER,
  ID_TRACK_TYPE,
  ID_CODEC_ID,
  ID_CODEC_PRIVATE,
  ID_LANGUAGE,
  ID_NAME,
  ID_CLUSTER,
  ID_TIMESTAMP,
  ID_SIMPLE_BLOCK,
  ID_BLOCK_GROUP,
  ID_BLOCK,
} from './ebml.js';
import { ByteStream } from './byteStream.js';

export class UnsupportedError extends Error {}

const VIDEO_OK = new Set(['V_MPEG4/ISO/AVC', 'V_MPEGH/ISO/HEVC']);
const AUDIO_OK = new Set(['A_AAC', 'A_MPEG/L3', 'A_OPUS']);

// BlockGroup children not exported from ebml.js
const ID_REFERENCE_BLOCK = 0xfb;

const TRACK_TYPE = { 1: 'video', 2: 'audio', 17: 'subtitle' };

const HEADER_PROBE = 64 * 1024;

function uintOf(bytes) {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

function floatOf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (bytes.length === 4) return dv.getFloat32(0);
  if (bytes.length === 8) return dv.getFloat64(0);
  throw new Error(`bad float size ${bytes.length}`);
}

function strOf(bytes) {
  return new TextDecoder().decode(bytes);
}

export class MkvDemuxer {
  constructor(fetchRange) {
    this.stream = new ByteStream(fetchRange);
    this.tracks = null;
    this.timecodeScale = 1_000_000;
    this.infoDuration = 0;
    this.firstClusterOff = 0;
    this.segmentEnd = Infinity;
    this.byNumber = new Map();
  }

  hdrAt(off) {
    return readElementHeader(this.stream.buf, off);
  }

  async readHeader() {
    if (this.tracks) return { tracks: this.tracks, timecodeScale: this.timecodeScale };
    try {
      await this.stream.ensure(0, HEADER_PROBE);
    } catch {
      // file smaller than probe; parse what we have
    }

    // Walk top-level elements to find the Segment.
    let off = 0;
    let segPayload = 0;
    for (;;) {
      await this.stream.ensure(off, 12);
      const h = this.hdrAt(off);
      if (h.id === ID_SEGMENT) {
        segPayload = off + h.headerSize;
        this.segmentEnd = h.size === -1 ? Infinity : segPayload + h.size;
        break;
      }
      if (h.size === -1) throw new Error('no Segment found');
      off += h.headerSize + h.size;
    }

    // Walk Segment children until Tracks parsed and first Cluster seen.
    let tracksEnd = 0;
    off = segPayload;
    for (;;) {
      await this.stream.ensure(off, 12);
      const h = this.hdrAt(off);
      const pay = off + h.headerSize;
      const end = h.size === -1 ? this.segmentEnd : pay + h.size;
      if (h.id === ID_INFO) {
        await this.stream.ensure(pay, h.size);
        this.parseInfo(pay, end);
      } else if (h.id === ID_TRACKS) {
        await this.stream.ensure(pay, h.size);
        this.parseTracks(pay, end);
        tracksEnd = end;
      } else if (h.id === ID_CLUSTER && tracksEnd > 0) {
        this.firstClusterOff = off;
        break;
      }
      if (h.size === -1) break;
      off = end;
      if (off >= this.segmentEnd) break;
    }
    if (!this.tracks) throw new Error('no Tracks found');
    if (!this.firstClusterOff) this.firstClusterOff = tracksEnd;

    for (const t of this.tracks) {
      if (t.type === 'video' && !VIDEO_OK.has(t.codecId)) {
        throw new UnsupportedError(`Unsupported video codec: ${t.codecId}`);
      }
      if (t.type === 'audio' && !AUDIO_OK.has(t.codecId)) {
        throw new UnsupportedError(`Unsupported audio codec: ${t.codecId}`);
      }
      this.byNumber.set(t.number, t);
    }
    return { tracks: this.tracks, timecodeScale: this.timecodeScale };
  }

  parseInfo(pay, end) {
    const buf = this.stream.buf;
    let p = pay;
    while (p < end) {
      const h = readElementHeader(buf, p);
      const v = p + h.headerSize;
      if (h.id === ID_TIMESTAMP_SCALE) this.timecodeScale = uintOf(buf.slice(v, v + h.size));
      else if (h.id === ID_DURATION) this.infoDuration = floatOf(buf.slice(v, v + h.size));
      p = v + h.size;
    }
  }

  parseTracks(pay, end) {
    const buf = this.stream.buf;
    const tracks = [];
    let p = pay;
    while (p < end) {
      const h = readElementHeader(buf, p);
      const v = p + h.headerSize;
      if (h.id === ID_TRACK_ENTRY) tracks.push(this.parseEntry(v, v + h.size));
      p = v + h.size;
    }
    this.tracks = tracks;
  }

  parseEntry(pay, end) {
    const buf = this.stream.buf;
    const t = { number: 0, type: null, codecId: '', codecPrivate: new Uint8Array(0), language: 'eng', name: '' };
    let p = pay;
    while (p < end) {
      const h = readElementHeader(buf, p);
      const v = p + h.headerSize;
      const body = buf.slice(v, v + h.size);
      if (h.id === ID_TRACK_NUMBER) t.number = uintOf(body);
      else if (h.id === ID_TRACK_TYPE) t.type = TRACK_TYPE[uintOf(body)] ?? null;
      else if (h.id === ID_CODEC_ID) t.codecId = strOf(body);
      else if (h.id === ID_CODEC_PRIVATE) t.codecPrivate = body;
      else if (h.id === ID_LANGUAGE) t.language = strOf(body);
      else if (h.id === ID_NAME) t.name = strOf(body);
      p = v + h.size;
    }
    return t;
  }

  durationSec() {
    return (this.infoDuration * this.timecodeScale) / 1e9;
  }

  // Split laced block payload into frames. dataOff is offset of first byte
  // after flags in stream.buf, dataEnd is payload end.
  splitFrames(lacing, dataOff, dataEnd) {
    const buf = this.stream.buf;
    if (lacing === 0) return [buf.slice(dataOff, dataEnd)];
    if (lacing === 1) {
      // Xiph lacing: count byte, then frameCount-1 sizes.
      let p = dataOff;
      const frames = buf[p++] + 1;
      const sizes = [];
      for (let i = 0; i < frames - 1; i++) {
        let s = 0;
        for (;;) {
          if (p >= dataEnd) throw new Error('bad Xiph lacing');
          const b = buf[p++];
          s += b;
          if (b !== 255) break;
        }
        sizes.push(s);
      }
      const out = [];
      for (let i = 0; i < frames - 1; i++) {
        out.push(buf.slice(p, p + sizes[i]));
        p += sizes[i];
      }
      out.push(buf.slice(p, dataEnd));
      return out;
    }
    throw new Error(`unsupported lacing mode ${lacing}`);
  }

  parseBlockPayload(pay, size, clusterTs) {
    const buf = this.stream.buf;
    const tn = readVint(buf, pay);
    let p = pay + tn.size;
    const rel = (buf[p] << 8) | buf[p + 1];
    const relS = (rel << 16) >> 16;
    const flags = buf[p + 2];
    p += 3;
    const lacing = (flags >> 1) & 3;
    const keyframe = !!(flags & 0x80);
    const frames = this.splitFrames(lacing, p, pay + size);
    const timestamp = ((clusterTs + relS) * this.timecodeScale) / 1e9;
    return { trackNumber: tn.value, timestamp, keyframe, frames };
  }

  async *samples(fromSec, toSec, trackNumbers) {
    if (!this.tracks) throw new Error('call readHeader first');
    const want = new Set(trackNumbers);
    let off = this.firstClusterOff;
    for (;;) {
      try {
        await this.stream.ensure(off, 12);
      } catch {
        return; // EOF
      }
      let h;
      try {
        h = this.hdrAt(off);
      } catch {
        return;
      }
      const pay = off + h.headerSize;
      const end = h.size === -1 ? this.segmentEnd : pay + h.size;
      if (h.id !== ID_CLUSTER) {
        if (h.size === -1) return;
        off = end;
        if (off >= this.segmentEnd) return;
        continue;
      }
      yield* this.walkCluster(pay, end, want, fromSec, toSec);
      if (h.size === -1) return;
      off = end;
      if (off >= this.segmentEnd) return;
    }
  }

  async *walkCluster(pay, end, want, fromSec, toSec) {
    let q = pay;
    let clusterTs = 0;
    while (q < end) {
      try {
        await this.stream.ensure(q, 12);
      } catch {
        return;
      }
      // NB: buffer must be re-read after every await — ensure() replaces
      // the internal array when it grows, so no stale reference survives.
      const h = readElementHeader(this.stream.buf, q);
      const v = q + h.headerSize;
      const pend = h.size === -1 ? end : v + h.size;
      if (h.id === ID_TIMESTAMP) {
        await this.stream.ensure(v, h.size);
        clusterTs = uintOf(this.stream.buf.slice(v, v + h.size));
      } else if (h.id === ID_SIMPLE_BLOCK) {
        await this.stream.ensure(v, h.size);
        const b = this.parseBlockPayload(v, h.size, clusterTs);
        if (want.has(b.trackNumber) && b.timestamp >= fromSec && b.timestamp <= toSec) {
          for (const f of b.frames) {
            yield { trackNumber: b.trackNumber, timestamp: b.timestamp, keyframe: b.keyframe, data: f };
          }
        }
      } else if (h.id === ID_BLOCK_GROUP) {
        await this.stream.ensure(v, h.size);
        yield* this.walkBlockGroup(v, pend, clusterTs, want, fromSec, toSec);
      }
      if (h.size === -1) return;
      q = pend;
    }
  }

  *walkBlockGroup(pay, end, clusterTs, want, fromSec, toSec) {
    const buf = this.stream.buf;
    let block = null;
    let hasRef = false;
    let q = pay;
    while (q < end) {
      const h = readElementHeader(buf, q);
      const v = q + h.headerSize;
      if (h.id === ID_BLOCK) block = this.parseBlockPayload(v, h.size, clusterTs);
      else if (h.id === ID_REFERENCE_BLOCK) hasRef = true;
      q = v + h.size;
    }
    if (block && want.has(block.trackNumber) && block.timestamp >= fromSec && block.timestamp <= toSec) {
      for (const f of block.frames) {
        yield { trackNumber: block.trackNumber, timestamp: block.timestamp, keyframe: !hasRef, data: f };
      }
    }
  }

  async subtitleCues(trackNumber) {
    if (!this.tracks) await this.readHeader();
    const track = this.byNumber.get(trackNumber);
    const raw = [];
    for await (const s of this.samples(0, Infinity, [trackNumber])) {
      let text = new TextDecoder().decode(s.data);
      if (track && track.codecId.startsWith('S_TEXT/ASS')) text = assText(text);
      raw.push({ start: s.timestamp, text });
    }
    raw.sort((a, b) => a.start - b.start);
    return raw.map((c, i) => ({
      start: c.start,
      end: i + 1 < raw.length ? raw[i + 1].start : c.start + 2,
      text: c.text,
    }));
  }
}

function assText(line) {
  let text = line;
  if (text.startsWith('Dialogue:')) {
    // Dialogue: Layer,Start,End,Style,Name,ML,MR,MV,Effect,Text
    let commas = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === ',') {
        commas++;
        if (commas === 9) {
          text = text.slice(i + 1);
          break;
        }
      }
    }
  }
  return text.replace(/\{[^}]*\}/g, '');
}
