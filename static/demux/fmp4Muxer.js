// fMP4 muxer: demuxed MKV samples -> fragmented MP4 (MSE-ready).
//
// Consumes MkvDemuxer track objects ({number,type,codecId,codecPrivate,...})
// and per-track sample arrays ({timestamp,keyframe,data}).
//
// NOTE: callers must pass samples for ONE track in timestamp (decode) order.
// MkvDemuxer.samples() yields file order, which is not globally monotonic
// across tracks, so fragments are built per track — no re-sorting here.

import { PASSTHROUGH_AUDIO } from './codecs.js';
import { dac3Payload, dec3Payload } from './ac3.js';

export function box(type, ...payloads) {
  const size = 8 + payloads.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  out.set([...type].map(c => c.charCodeAt(0)), 4);
  let off = 8;
  for (const p of payloads) { out.set(p, off); off += p.length; }
  return out;
}

function fullBox(type, version, flags, ...payloads) {
  const h = new Uint8Array(4);
  h[0] = version;
  h[1] = (flags >>> 16) & 0xff;
  h[2] = (flags >>> 8) & 0xff;
  h[3] = flags & 0xff;
  return box(type, h, ...payloads);
}

function u16(v) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v);
  return b;
}

function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}

function u64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v));
  return b;
}

function i32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v);
  return b;
}

function zeros(n) {
  return new Uint8Array(n);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function parseASC(priv) {
  if (priv.length < 2) throw new Error('AAC track missing AudioSpecificConfig');
  const aot = priv[0] >>> 3;
  const freqIdx = ((priv[0] & 7) << 1) | (priv[1] >>> 7);
  const channels = (priv[1] >>> 3) & 15;
  let rate = AAC_RATES[freqIdx];
  if (freqIdx === 15) {
    if (priv.length < 5) throw new Error('AAC explicit sample rate missing');
    rate = (priv[2] << 16) | (priv[3] << 8) | priv[4];
  }
  if (!rate) throw new Error(`bad AAC sampling index ${freqIdx}`);
  return { aot, rate, channels: channels || 2 };
}

// AC-3/E-AC-3 config comes from the first frame (MkvDemuxer.probeAc3).
function ac3Info(track) {
  if (!track.ac3) throw new Error(`${track.codecId} track missing first-frame config`);
  return track.ac3;
}

function timescaleFor(track) {
  if (track.type === 'audio') {
    if (PASSTHROUGH_AUDIO.has(track.codecId)) return ac3Info(track).sampleRate;
    if (track.codecId === 'A_AAC') return parseASC(track.codecPrivate).rate;
    if (track.codecId === 'A_OPUS') return 48000;
    // MP3 in MKV carries no sample rate/channel count: assume 44100/stereo
    // (matches the stsd entry below) until real MP3 fixtures exist.
    if (track.codecId === 'A_MPEG/L3') return 44100;
  }
  return 90000;
}

function hex(b, n = 2) {
  return b.toString(16).toLowerCase().padStart(n, '0');
}

export function codecString(track) {
  switch (track.codecId) {
    case 'V_MPEG4/ISO/AVC': {
      const p = track.codecPrivate;
      if (p.length < 4) throw new Error('AVC track missing avcC');
      return `avc1.${hex(p[1])}${hex(p[2])}${hex(p[3])}`;
    }
    case 'V_MPEGH/ISO/HEVC': {
      const p = track.codecPrivate;
      if (p.length < 13) throw new Error('HEVC track missing hvcC');
      const idc = p[1] & 31;
      const compat = ((p[2] << 24) | (p[3] << 16) | (p[4] << 8) | p[5]) >>> 0;
      const tier = (p[1] & 32) ? 'H' : 'L';
      const constraints = [...p.slice(6, 12)].map(b => hex(b)).join('');
      return `hev1.${idc}.${compat.toString(16).toLowerCase().padStart(8, '0')}.${tier}${p[12]}.${constraints}`;
    }
    case 'A_AAC':
      return `mp4a.40.${parseASC(track.codecPrivate).aot}`;
    case 'A_MPEG/L3':
      return 'mp4a.69';
    case 'A_OPUS':
      return 'opus';
    case 'A_AC3':
    case 'A_EAC3':
      return PASSTHROUGH_AUDIO.get(track.codecId);
    default:
      throw new Error(`unsupported codec for MSE: ${track.codecId}`);
  }
}

function langCode(lang) {
  if (!lang || lang.length < 3) return u16(0x55c4); // 'und'
  const c = lang.slice(0, 3).toLowerCase();
  return u16(((c.charCodeAt(0) - 0x60) << 10) | ((c.charCodeAt(1) - 0x60) << 5) | (c.charCodeAt(2) - 0x60));
}

const IDENTITY_MATRIX = new Uint8Array([
  0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

function descTag(tag, payload) {
  // descriptor size as base-128 varlen (payloads here are tiny)
  let n = payload.length;
  const len = [];
  do { len.unshift(n & 0x7f); n >>>= 7; } while (n > 0);
  for (let i = 0; i < len.length - 1; i++) len[i] |= 0x80;
  return concat([new Uint8Array([tag, ...len]), payload]);
}

function esds(objectType, asc) {
  const dsi = asc.length ? [descTag(0x05, asc)] : [];
  const decConfig = concat([
    new Uint8Array([objectType, 0x15, 0, 0, 0]), // streamType=AudioStream
    zeros(8), // maxBitrate + avgBitrate unknown
    ...dsi,
  ]);
  const es = concat([u16(1), new Uint8Array([0]), descTag(0x04, decConfig), descTag(0x06, new Uint8Array([2]))]);
  return fullBox('esds', 0, 0, descTag(0x03, es));
}

function visualEntry(fourcc, codecBox) {
  return box(fourcc,
    zeros(6), u16(1),
    zeros(16), // pre_defined + reserved
    u16(0), u16(0), // width/height unknown to demuxer; decoders use SPS
    u32(0x00480000), u32(0x00480000), u32(0),
    u16(1), zeros(32), u16(0x18), u16(0xffff),
    codecBox);
}

function audioEntry(fourcc, channels, rate, codecBox) {
  return box(fourcc,
    zeros(6), u16(1),
    zeros(8),
    u16(channels), u16(16),
    u16(0), u16(0),
    u32(rate << 16),
    codecBox);
}

function sampleEntry(track) {
  switch (track.codecId) {
    case 'V_MPEG4/ISO/AVC':
      return visualEntry('avc1', box('avcC', track.codecPrivate));
    case 'V_MPEGH/ISO/HEVC':
      return visualEntry('hev1', box('hvcC', track.codecPrivate));
    case 'A_AAC': {
      const { rate, channels } = parseASC(track.codecPrivate);
      const asc = track.codecPrivate.slice(0, 2);
      return audioEntry('mp4a', channels, rate, esds(0x40, asc));
    }
    case 'A_MPEG/L3':
      return audioEntry('mp4a', 2, 44100, esds(0x69, new Uint8Array(0)));
    case 'A_OPUS': {
      const p = track.codecPrivate;
      if (p.length < 10) throw new Error('Opus track missing OpusHead');
      return audioEntry('Opus', p[9] || 2, 48000, box('dOps', p.slice(8)));
    }
    // ETSI TS 102 366 F.3/F.5: ChannelCount is fixed at 2 (the real layout
    // is in dac3/dec3).
    case 'A_AC3': {
      const info = ac3Info(track);
      return audioEntry('ac-3', 2, info.sampleRate, box('dac3', dac3Payload(info)));
    }
    case 'A_EAC3': {
      const info = ac3Info(track);
      return audioEntry('ec-3', 2, info.sampleRate, box('dec3', dec3Payload(info)));
    }
    default:
      throw new Error(`unsupported codec for MSE: ${track.codecId}`);
  }
}

export function initSegment(track) {
  const scale = timescaleFor(track);
  const isVideo = track.type === 'video';
  const handler = isVideo ? 'vide' : 'soun';
  const hdlrName = new TextEncoder().encode(isVideo ? 'VideoHandler\0' : 'SoundHandler\0');

  const ftyp = box('ftyp',
    new TextEncoder().encode('isom'), u32(0),
    new TextEncoder().encode('isomavc1mp41'));

  const mvhd = fullBox('mvhd', 0, 0,
    u32(0), u32(0), u32(scale), u32(0), // ctime, mtime, timescale, duration unknown
    u32(0x00010000), u16(0x0100), zeros(10),
    IDENTITY_MATRIX, zeros(24), u32(2));

  const tkhd = fullBox('tkhd', 0, 7,
    u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8),
    u16(0), u16(0), isVideo ? u16(0) : u16(0x0100), u16(0),
    IDENTITY_MATRIX, u32(0), u32(0));

  const mdhd = fullBox('mdhd', 0, 0,
    u32(0), u32(0), u32(scale), u32(0), langCode(track.language), u16(0));

  const hdlr = fullBox('hdlr', 0, 0,
    u32(0), new TextEncoder().encode(handler), zeros(12), hdlrName);

  const mediaHeader = isVideo
    ? fullBox('vmhd', 0, 1, u16(0), zeros(6))
    : fullBox('smhd', 0, 0, u16(0), u16(0));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), sampleEntry(track)),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)));
  const minf = box('minf', mediaHeader, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);
  // mvex/trex required for fragmented MP4 (MSE rejects init without it)
  const mvex = box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  return concat([ftyp, box('moov', mvhd, trak, mvex)]);
}

// One duration for every sample in the fragment. AAC frames are always
// 1024 samples. Otherwise the smallest positive PTS step: with B-frames in
// decode order some adjacent PTS diffs are huge (I0 -> P4) or negative, so
// per-sample diffs would stretch the decode timeline and break A/V sync.
// VFR content is approximated (documented limitation).
function estimateDuration(track, pts) {
  if (track.codecId === 'A_AAC') return 1024;
  // AC-3: 1536 samples per frame; E-AC-3 per MKV block from the first frame.
  // MKV's 1ms timestamps can't give these exactly.
  if (PASSTHROUGH_AUDIO.has(track.codecId)) return ac3Info(track).samplesPerFrame;
  // sorted copy, estimation only — sample order is never touched
  const sorted = [...pts].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const d = sorted[i + 1] - sorted[i];
    if (d > 0 && (best === 0 || d < best)) best = d;
  }
  if (best > 0) return best;
  return track.type === 'audio' ? 1024 : Math.round(timescaleFor(track) / 25);
}

export function fragment(track, samples, baseDecodeTime, seqNum = 1) {
  if (!samples.length) throw new Error('fragment needs at least one sample');
  const scale = timescaleFor(track);
  const pts = samples.map(s => Math.round(s.timestamp * scale));
  const dur = estimateDuration(track, pts);
  const durations = samples.map(() => dur);

  let dts = baseDecodeTime;
  const cts = pts.map((p, i) => {
    const c = p - dts;
    dts += durations[i];
    return c;
  });
  const v1 = cts.some(c => c < 0);

  const entries = samples.map((s, i) => concat([
    u32(durations[i]),
    u32(s.data.length),
    u32(s.keyframe ? 0x02000000 : 0x01010000),
    v1 ? i32(cts[i]) : u32(cts[i]),
  ]));

  // trun data_offset is relative to moof start (default-base-is-moof).
  const trunSize = 8 + 4 + 4 + 4 + entries.length * 16;
  const trafSize = 8 + 16 + 20 + trunSize; // traf + tfhd + tfdt(v1) + trun
  const moofSize = 8 + 16 + trafSize; // moof + mfhd + traf
  const dataOffset = moofSize + 8; // + mdat header

  const mfhd = fullBox('mfhd', 0, 0, u32(seqNum));
  const tfhd = fullBox('tfhd', 0, 0x020000, u32(1));
  const tfdt = fullBox('tfdt', 1, 0, u64(baseDecodeTime));
  const trun = fullBox('trun', v1 ? 1 : 0, 0x0f01, u32(samples.length), u32(dataOffset), ...entries);
  const moof = box('moof', mfhd, box('traf', tfhd, tfdt, trun));
  return concat([moof, box('mdat', ...samples.map(s => s.data))]);
}
