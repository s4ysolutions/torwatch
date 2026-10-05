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
  ID_SEEK_HEAD,
  ID_CUES,
} from './ebml.js';
import { ByteStream } from './byteStream.js';
import { audioSupport, PASSTHROUGH_AUDIO } from './codecs.js';
import { parseAc3Frame } from './ac3.js';

export class UnsupportedError extends Error {}

const VIDEO_OK = new Set(['V_MPEG4/ISO/AVC', 'V_MPEGH/ISO/HEVC']);

// Elements not exported from ebml.js
const ID_REFERENCE_BLOCK = 0xfb;
const ID_BLOCK_DURATION = 0x9b;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_TRACK = 0xf7;
const ID_CUE_CLUSTER_POSITION = 0xf1;
// Cluster-skip fallback reads only headers: small fetches per cluster.
const SKIP_CHUNK = 4 * 1024;

const TRACK_TYPE = { 1: 'video', 2: 'audio', 17: 'subtitle' };

const HEADER_PROBE = 64 * 1024;
// How far past the first cluster to look for the first frame of a
// passthrough audio track.
const FRAME_PROBE = 2 * 1024 * 1024;

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

// opts.canPlayAudio(track) => boolean decides per audio track whether the
// player can use it (default: codecs every MSE browser decodes). Audio
// tracks get `playable`; readHeader throws only when no audio track is.
export class MkvDemuxer {
  constructor(fetchRange, opts = {}) {
    this.fetchRange = fetchRange;
    this.opts = opts;
    // Header parsing only; every samples() walk gets its own ByteStream so
    // concurrent readers (playback pump after a seek, AC-3 probe) never
    // share or reset each other's window.
    this.stream = this.newStream();
    this.canPlayAudio = typeof opts.canPlayAudio === 'function' ? opts.canPlayAudio : audioSupport();
    this.tracks = null;
    this.timecodeScale = 1_000_000;
    this.infoDuration = 0;
    this.firstClusterOff = 0;
    this.segmentEnd = Infinity;
    this.byNumber = new Map();
    this.segPayload = 0;
    this.cuesOff = null; // absolute offset of Cues (from SeekHead), if any
    this.cues = null; // [{sec, off}] sorted, loaded on first seek
  }

  newStream(chunkSize = this.opts.chunkSize) {
    return new ByteStream(this.fetchRange, chunkSize, this.opts.maxBytes);
  }

  // off is absolute; the stream holds a sliding window — re-derive the
  // relative index at every call (never cache across awaits).
  hdrAt(off, st = this.stream) {
    return readElementHeader(st.buf, off - st.winStart);
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
    this.segPayload = segPayload;
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
      } else if (h.id === ID_SEEK_HEAD && h.size !== -1) {
        await this.stream.ensure(pay, h.size);
        this.parseSeekHead(pay, end);
      } else if (h.id === ID_CUES && this.cuesOff == null) {
        this.cuesOff = off;
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
      if (t.type === 'audio') {
        try {
          t.playable = !!this.canPlayAudio(t);
        } catch {
          t.playable = false;
        }
      }
      this.byNumber.set(t.number, t);
    }
    const audio = this.tracks.filter((t) => t.type === 'audio');
    const assertPlayableAudio = () => {
      if (audio.length && !audio.some((t) => t.playable)) {
        const codecs = [...new Set(audio.map((t) => t.codecId))].join(', ');
        throw new UnsupportedError(`Unsupported audio codec: ${codecs}`);
      }
    };
    assertPlayableAudio();
    const probe = audio.filter((t) => t.playable && PASSTHROUGH_AUDIO.has(t.codecId));
    if (probe.length) {
      await this.probeAc3(probe);
      assertPlayableAudio();
    }
    return { tracks: this.tracks, timecodeScale: this.timecodeScale };
  }

  // AC-3/E-AC-3 carry no CodecPrivate: read each track's first frame for
  // the fMP4 config (track.ac3). A track whose frame isn't found within
  // FRAME_PROBE bytes, or doesn't parse, is marked unplayable.
  async probeAc3(tracks) {
    const want = new Map(tracks.map((t) => [t.number, t]));
    const budget = Math.min(FRAME_PROBE, Math.floor(this.stream.maxBytes / 2));
    try {
      for await (const s of this.samples(0, Infinity, [...want.keys()], this.firstClusterOff + budget)) {
        const t = want.get(s.trackNumber);
        if (!t) continue;
        want.delete(s.trackNumber);
        t.ac3 = parseAc3Frame(s.data);
        if (!want.size) break;
      }
    } catch {
      // read failure: tracks not reached stay unconfigured → unplayable
    }
    for (const t of tracks) if (!t.ac3) t.playable = false;
  }

  parseSeekHead(pay, end) {
    const buf = this.stream.buf;
    const ws = this.stream.winStart;
    for (let p = pay; p < end;) {
      const h = readElementHeader(buf, p - ws);
      const v = p + h.headerSize;
      if (h.id === ID_SEEK) {
        let id = 0;
        let pos = -1;
        for (let q = v; q < v + h.size;) {
          const c = readElementHeader(buf, q - ws);
          const body = buf.slice(q + c.headerSize - ws, q + c.headerSize + c.size - ws);
          if (c.id === ID_SEEK_ID) id = uintOf(body);
          else if (c.id === ID_SEEK_POSITION) pos = uintOf(body);
          q += c.headerSize + c.size;
        }
        if (id === ID_CUES && pos >= 0) this.cuesOff = this.segPayload + pos;
      }
      p = v + h.size;
    }
  }

  // Cues → [{sec, off}] for the video track (any track if no video).
  // Loaded once, on the first seek; a missing or broken index → [].
  async loadCues() {
    if (this.cues) return this.cues;
    this.cues = [];
    if (this.cuesOff == null) return this.cues;
    try {
      const st = this.newStream(SKIP_CHUNK);
      await st.ensure(this.cuesOff, 12);
      const h = this.hdrAt(this.cuesOff, st);
      if (h.id !== ID_CUES || h.size === -1) return this.cues;
      const pay = this.cuesOff + h.headerSize;
      await st.ensure(pay, h.size);
      const buf = st.buf;
      const ws = st.winStart;
      const video = this.tracks.find((t) => t.type === 'video')?.number;
      const points = [];
      for (let p = pay; p < pay + h.size;) {
        const cp = readElementHeader(buf, p - ws);
        const v = p + cp.headerSize;
        if (cp.id === ID_CUE_POINT) {
          let time = -1;
          for (let q = v; q < v + cp.size;) {
            const c = readElementHeader(buf, q - ws);
            const cv = q + c.headerSize;
            if (c.id === ID_CUE_TIME) time = uintOf(buf.slice(cv - ws, cv + c.size - ws));
            else if (c.id === ID_CUE_TRACK_POSITIONS) {
              let track = 0;
              let pos = -1;
              for (let r = cv; r < cv + c.size;) {
                const e = readElementHeader(buf, r - ws);
                const body = buf.slice(r + e.headerSize - ws, r + e.headerSize + e.size - ws);
                if (e.id === ID_CUE_TRACK) track = uintOf(body);
                else if (e.id === ID_CUE_CLUSTER_POSITION) pos = uintOf(body);
                r += e.headerSize + e.size;
              }
              if (time >= 0 && pos >= 0 && (video == null || track === video)) {
                points.push({ sec: (time * this.timecodeScale) / 1e9, off: this.segPayload + pos });
              }
            }
            q = cv + c.size;
          }
        }
        p = v + cp.size;
      }
      points.sort((a, b) => a.sec - b.sec);
      this.cues = points;
    } catch {
      this.cues = [];
    }
    return this.cues;
  }

  // Byte offset of the cluster to start a walk at for fromSec: the last
  // cue point at or before fromSec, else firstClusterOff (cluster-skip
  // then narrows it further, see clusterStart).
  async seekOffset(fromSec) {
    if (!(fromSec > 0)) return this.firstClusterOff;
    const cues = await this.loadCues();
    let off = this.firstClusterOff;
    for (const c of cues) {
      if (c.sec > fromSec) break;
      off = c.off;
    }
    return off;
  }

  // Cluster timestamp (seconds) of the cluster at off, reading only its
  // header and the children before Timestamp (CRC-32/Void); null when
  // the Timestamp isn't among the leading small children.
  async clusterTime(st, off) {
    await st.ensure(off, 12);
    const h = this.hdrAt(off, st);
    if (h.id !== ID_CLUSTER) return { h, sec: null };
    let q = off + h.headerSize;
    for (let i = 0; i < 4; i++) {
      await st.ensure(q, 12);
      const c = this.hdrAt(q, st);
      if (c.size < 0 || c.size > 64) break; // reached a block: give up
      if (c.id === ID_TIMESTAMP) {
        await st.ensure(q + c.headerSize, c.size);
        return { h, sec: (uintOf(st.absSlice(q + c.headerSize, c.size)) * this.timecodeScale) / 1e9 };
      }
      q += c.headerSize + c.size;
    }
    return { h, sec: null };
  }

  // Without Cues: hop cluster headers (no payload fetch) while the NEXT
  // cluster still starts at or before fromSec.
  async clusterStart(off, fromSec) {
    if (!(fromSec > 0)) return off;
    const st = this.newStream(SKIP_CHUNK);
    try {
      for (;;) {
        const { h } = await this.clusterTime(st, off);
        if (h.id !== ID_CLUSTER || h.size === -1) return off;
        const next = off + h.headerSize + h.size;
        if (next >= this.segmentEnd) return off;
        const n = await this.clusterTime(st, next);
        if (n.h.id !== ID_CLUSTER || n.sec == null || n.sec > fromSec) return off;
        off = next;
      }
    } catch {
      return off;
    }
  }

  parseInfo(pay, end) {
    // Sync: no awaits inside, so one buf/winStart snapshot is safe.
    // pay/end are absolute; index the window relatively.
    const buf = this.stream.buf;
    const ws = this.stream.winStart;
    let p = pay;
    while (p < end) {
      const h = readElementHeader(buf, p - ws);
      const v = p + h.headerSize;
      const rel = v - ws;
      if (h.id === ID_TIMESTAMP_SCALE) this.timecodeScale = uintOf(buf.slice(rel, rel + h.size));
      else if (h.id === ID_DURATION) this.infoDuration = floatOf(buf.slice(rel, rel + h.size));
      p = v + h.size;
    }
  }

  parseTracks(pay, end) {
    const buf = this.stream.buf;
    const ws = this.stream.winStart;
    const tracks = [];
    let p = pay;
    while (p < end) {
      const h = readElementHeader(buf, p - ws);
      const v = p + h.headerSize;
      if (h.id === ID_TRACK_ENTRY) tracks.push(this.parseEntry(v, v + h.size));
      p = v + h.size;
    }
    this.tracks = tracks;
  }

  parseEntry(pay, end) {
    const buf = this.stream.buf;
    const ws = this.stream.winStart;
    const t = { number: 0, type: null, codecId: '', codecPrivate: new Uint8Array(0), language: 'eng', name: '' };
    let p = pay;
    while (p < end) {
      const h = readElementHeader(buf, p - ws);
      const v = p + h.headerSize;
      const rel = v - ws;
      const body = buf.slice(rel, rel + h.size); // fresh copy
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

  // Split laced block payload into frames. dataOff is the absolute offset
  // of the first byte after flags, dataEnd the absolute payload end.
  // Returns fresh copies. Sync: one window snapshot is safe.
  splitFrames(lacing, dataOff, dataEnd, st = this.stream) {
    const buf = st.buf;
    const ws = st.winStart;
    const rel = (abs) => abs - ws;
    const dataRelEnd = rel(dataEnd);
    if (lacing === 0) return [buf.slice(rel(dataOff), dataRelEnd)];
    if (lacing === 1) {
      // Xiph lacing: count byte, then frameCount-1 sizes.
      let p = rel(dataOff);
      const frames = buf[p++] + 1;
      const sizes = [];
      for (let i = 0; i < frames - 1; i++) {
        let s = 0;
        for (;;) {
          if (p >= dataRelEnd) throw new Error('bad Xiph lacing');
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
      out.push(buf.slice(p, dataRelEnd));
      return out;
    }
    if (lacing === 2) {
      // Fixed-size lacing: count byte, frames split the rest equally.
      const p = rel(dataOff);
      const frames = buf[p] + 1;
      const body = p + 1;
      const total = dataRelEnd - body;
      if (frames <= 0 || total < 0 || total % frames !== 0) throw new Error('bad fixed-size lacing');
      const size = total / frames;
      const out = [];
      for (let i = 0; i < frames; i++) out.push(buf.slice(body + i * size, body + (i + 1) * size));
      return out;
    }
    if (lacing === 3) {
      // EBML lacing: count byte, first size unsigned vint, the rest signed
      // diffs to the previous size (bias 2^(7*len-1)-1). Last frame = rest.
      let p = rel(dataOff);
      if (p >= dataRelEnd) throw new Error('bad EBML lacing');
      const frames = buf[p++] + 1;
      const sizes = [];
      for (let i = 0; i < frames - 1; i++) {
        if (p >= dataRelEnd) throw new Error('bad EBML lacing');
        const v = readVint(buf, p);
        if (v.size > 6 || v.value === -1) throw new Error('bad EBML lacing');
        p += v.size;
        if (i === 0) sizes.push(v.value);
        else sizes.push(sizes[i - 1] + (v.value - (Math.pow(2, 7 * v.size - 1) - 1)));
      }
      const out = [];
      for (let i = 0; i < frames - 1; i++) {
        if (sizes[i] < 0 || p + sizes[i] > dataRelEnd) throw new Error('bad EBML lacing');
        out.push(buf.slice(p, p + sizes[i]));
        p += sizes[i];
      }
      out.push(buf.slice(p, dataRelEnd));
      return out;
    }
    throw new Error(`unsupported lacing mode ${lacing}`);
  }

  parseBlockPayload(st, pay, size, clusterTs) {
    // Sync: snapshot the window once; pay/size are absolute.
    const buf = st.buf;
    const ws = st.winStart;
    const tn = readVint(buf, pay - ws);
    let p = pay - ws + tn.size;
    const rel = (buf[p] << 8) | buf[p + 1];
    const relS = (rel << 16) >> 16;
    const flags = buf[p + 2];
    p += 3;
    const lacing = (flags >> 1) & 3;
    const keyframe = !!(flags & 0x80);
    const frames = this.splitFrames(lacing, p + ws, pay + size, st);
    const timestamp = ((clusterTs + relS) * this.timecodeScale) / 1e9;
    return { trackNumber: tn.value, timestamp, keyframe, frames };
  }

  // Yields {trackNumber, timestamp, keyframe, data, duration?} in file
  // order. fromSec > 0 starts at the cluster holding fromSec (Cues, else a
  // header-only cluster skip) and yields everything from there, so video
  // starts at that cluster's keyframe rather than mid-GOP; toSec is an
  // upper bound. stopAt (absolute byte offset, optional) ends the walk.
  async *samples(fromSec, toSec, trackNumbers, stopAt = Infinity) {
    if (!this.tracks) throw new Error('call readHeader first');
    const want = new Set(trackNumbers);
    const st = this.newStream();
    let off = await this.clusterStart(await this.seekOffset(fromSec), fromSec);
    for (;;) {
      if (off >= stopAt) return;
      try {
        await st.ensure(off, 12);
      } catch {
        return; // EOF
      }
      let h;
      try {
        h = this.hdrAt(off, st);
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
      yield* this.walkCluster(st, pay, end, want, toSec, stopAt);
      if (h.size === -1) return;
      off = end;
      if (off >= this.segmentEnd) return;
    }
  }

  async *walkCluster(st, pay, end, want, toSec, stopAt = Infinity) {
    let q = pay;
    let clusterTs = 0;
    while (q < end && q < stopAt) {
      try {
        await st.ensure(q, 12);
      } catch {
        return;
      }
      // NB: buffer must be re-read after every await — ensure() replaces
      // the internal array on grow/evict/reset (sliding window), so no
      // stale reference or absolute index survives. hdrAt()/absSlice()
      // re-derive window-relative positions on each call.
      const h = this.hdrAt(q, st);
      const v = q + h.headerSize;
      const pend = h.size === -1 ? end : v + h.size;
      if (h.id === ID_TIMESTAMP) {
        await st.ensure(v, h.size);
        clusterTs = uintOf(st.absSlice(v, h.size));
      } else if (h.id === ID_SIMPLE_BLOCK) {
        await st.ensure(v, h.size);
        const b = this.parseBlockPayload(st, v, h.size, clusterTs);
        if (want.has(b.trackNumber) && b.timestamp <= toSec) {
          for (const f of b.frames) {
            yield { trackNumber: b.trackNumber, timestamp: b.timestamp, keyframe: b.keyframe, data: f };
          }
        }
      } else if (h.id === ID_BLOCK_GROUP) {
        await st.ensure(v, h.size);
        yield* this.walkBlockGroup(st, v, pend, clusterTs, want, toSec);
      }
      if (h.size === -1) return;
      q = pend;
    }
  }

  // Sync generator: runs to the next yield without interleaving awaits,
  // so one window snapshot is safe. Yields fresh copies only.
  *walkBlockGroup(st, pay, end, clusterTs, want, toSec) {
    const buf = st.buf;
    const ws = st.winStart;
    let block = null;
    let hasRef = false;
    let duration;
    let q = pay;
    while (q < end) {
      const h = readElementHeader(buf, q - ws);
      const v = q + h.headerSize;
      if (h.id === ID_BLOCK) block = this.parseBlockPayload(st, v, h.size, clusterTs);
      else if (h.id === ID_REFERENCE_BLOCK) hasRef = true;
      else if (h.id === ID_BLOCK_DURATION) duration = (uintOf(buf.slice(v - ws, v + h.size - ws)) * this.timecodeScale) / 1e9;
      q = v + h.size;
    }
    if (block && want.has(block.trackNumber) && block.timestamp <= toSec) {
      for (const f of block.frames) {
        yield { trackNumber: block.trackNumber, timestamp: block.timestamp, keyframe: !hasRef, data: f, duration };
      }
    }
  }

  // Subtitle sample → {start, end, text}. end uses BlockDuration when the
  // file has it; otherwise null (caller decides, e.g. next cue's start).
  subtitleCue(s) {
    const track = this.byNumber.get(s.trackNumber);
    let text = new TextDecoder().decode(s.data);
    if (track && track.codecId.startsWith('S_TEXT/ASS')) text = assText(text);
    return { start: s.timestamp, end: s.duration != null ? s.timestamp + s.duration : null, text };
  }

  // Whole-track extraction: walks (downloads) the entire file. The player
  // collects cues from its own stream instead (see subtitleCue); this is
  // for small files and tests.
  async subtitleCues(trackNumber) {
    if (!this.tracks) await this.readHeader();
    const raw = [];
    for await (const s of this.samples(0, Infinity, [trackNumber])) raw.push(this.subtitleCue(s));
    return finishCues(raw);
  }
}

// Sort by start; a cue without its own end runs to the next cue's start
// (last one: +2s).
export function finishCues(raw) {
  const cues = [...raw].sort((a, b) => a.start - b.start);
  return cues.map((c, i) => ({
    start: c.start,
    end: c.end ?? (i + 1 < cues.length ? cues[i + 1].start : c.start + 2),
    text: c.text,
  }));
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
