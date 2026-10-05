// AC-3 / E-AC-3 syncframe header parsing (ETSI TS 102 366) and the MP4
// decoder config payloads built from it (dac3: Annex F.4, dec3: Annex F.6).
//
// MKV A_AC3/A_EAC3 tracks carry no CodecPrivate, so the fMP4 sample entry
// config comes from the first frame of the track.

const AC3_RATES = [48000, 44100, 32000];
const EAC3_HALF_RATES = [24000, 22050, 16000];
const ACMOD_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];
const NUMBLKS = [1, 2, 3, 6];
// kbps by frmsizecod >> 1
const AC3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];

function bitReader(bytes, byteOff) {
  let pos = byteOff * 8;
  return (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
    return v;
  };
}

function parseAc3(f) {
  const fscod = f[4] >> 6;
  const frmsizecod = f[4] & 0x3f;
  if (fscod === 3 || frmsizecod >> 1 >= AC3_BITRATES.length) return null;
  const read = bitReader(f, 5);
  const bsid = read(5);
  const bsmod = read(3);
  const acmod = read(3);
  if ((acmod & 1) && acmod !== 1) read(2); // cmixlev
  if (acmod & 4) read(2); // surmixlev
  if (acmod === 2) read(2); // dsurmod
  const lfeon = read(1);
  return {
    codec: 'ac-3',
    sampleRate: AC3_RATES[fscod],
    channels: ACMOD_CHANNELS[acmod] + lfeon,
    samplesPerFrame: 1536,
    fscod,
    bsid,
    bsmod,
    acmod,
    lfeon,
    bitRateCode: frmsizecod >> 1,
    dataRate: AC3_BITRATES[frmsizecod >> 1],
  };
}

// One E-AC-3 block may hold several syncframes (dependent substreams, or
// 1/2/3-block frames packed together); samples per block counts only the
// independent substream 0 frames.
function parseEac3(f) {
  const fscod = f[4] >> 6;
  const code2 = (f[4] >> 4) & 3;
  const sampleRate = fscod === 3 ? EAC3_HALF_RATES[code2] : AC3_RATES[fscod];
  if (!sampleRate) return null;
  const acmod = (f[4] >> 1) & 7;
  const lfeon = f[4] & 1;
  const bsid = f[5] >> 3;
  let samples = 0;
  let bytes = 0;
  for (let p = 0; p + 6 <= f.length;) {
    if (f[p] !== 0x0b || f[p + 1] !== 0x77) break;
    const strmtyp = f[p + 2] >> 6;
    const substreamid = (f[p + 2] >> 3) & 7;
    const size = (((f[p + 2] & 7) << 8) | f[p + 3]) * 2 + 2;
    const fs = f[p + 4] >> 6;
    if (strmtyp !== 1 && substreamid === 0) samples += 256 * (fs === 3 ? 6 : NUMBLKS[(f[p + 4] >> 4) & 3]);
    bytes += size;
    p += size;
  }
  const samplesPerFrame = samples || 1536;
  return {
    codec: 'ec-3',
    sampleRate,
    channels: ACMOD_CHANNELS[acmod] + lfeon,
    samplesPerFrame,
    fscod,
    bsid,
    bsmod: 0, // lives deep in the optional info metadata; 0 = main audio
    acmod,
    lfeon,
    dataRate: Math.round((bytes * 8 * sampleRate) / samplesPerFrame / 1000),
  };
}

// parseAc3Frame(frame) => info | null. bsid <= 10 is AC-3, 11..16 E-AC-3.
export function parseAc3Frame(frame) {
  if (!frame || frame.length < 8 || frame[0] !== 0x0b || frame[1] !== 0x77) return null;
  const bsid = frame[5] >> 3;
  if (bsid <= 10) return parseAc3(frame);
  if (bsid <= 16) return parseEac3(frame);
  return null;
}

// dac3 payload: fscod(2) bsid(5) bsmod(3) acmod(3) lfeon(1) bit_rate_code(5) reserved(5).
export function dac3Payload(info) {
  const v =
    (info.fscod << 22) | (info.bsid << 17) | (info.bsmod << 14) |
    (info.acmod << 11) | (info.lfeon << 10) | (info.bitRateCode << 5);
  return new Uint8Array([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
}

// dec3 payload, one independent substream without dependents:
// data_rate(13) num_ind_sub(3)=0 | fscod(2) bsid(5) reserved(1) asvc(1)
// bsmod(3) acmod(3) lfeon(1) reserved(3) num_dep_sub(4) reserved(1).
export function dec3Payload(info) {
  const head = ((info.dataRate & 0x1fff) << 3) | 0;
  const sub =
    (info.fscod << 22) | (info.bsid << 17) | (info.bsmod << 12) |
    (info.acmod << 9) | (info.lfeon << 8);
  return new Uint8Array([
    (head >> 8) & 0xff, head & 0xff,
    (sub >> 16) & 0xff, (sub >> 8) & 0xff, sub & 0xff,
  ]);
}
