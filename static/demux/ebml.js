export function readVint(buf, off, keepMarker = false) {
  const first = buf[off];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || off + len > buf.length) throw new Error('bad vint');
  let value = keepMarker ? first : first & (0xFF >> len);
  for (let i = 1; i < len; i++) value = value * 256 + buf[off + i];
  // all-ones payload = unknown size
  if (!keepMarker) {
    const max = Math.pow(2, 7 * len) - 1;
    if (value === max) return { value: -1, size: len };
  }
  return { value, size: len };
}

export function readElementHeader(buf, off) {
  const id = readVint(buf, off, true);
  const sz = readVint(buf, off + id.size);
  return { id: id.value, size: sz.value, headerSize: id.size + sz.size };
}

export const ID_EBML = 0x1A45DFA3, ID_SEGMENT = 0x18538067, ID_SEEK_HEAD = 0x114D9B74,
  ID_INFO = 0x1549A966, ID_TIMESTAMP_SCALE = 0x2AD7B1, ID_DURATION = 0x4489,
  ID_TRACKS = 0x1654AE6B, ID_TRACK_ENTRY = 0xAE, ID_TRACK_NUMBER = 0xD7,
  ID_TRACK_TYPE = 0x83, ID_CODEC_ID = 0x86, ID_CODEC_PRIVATE = 0x63A2,
  ID_LANGUAGE = 0x22B59C, ID_NAME = 0x536E, ID_CLUSTER = 0x1F43B675,
  ID_TIMESTAMP = 0xE7, ID_SIMPLE_BLOCK = 0xA3, ID_BLOCK_GROUP = 0xA0,
  ID_BLOCK = 0xA1, ID_CUES = 0x1C53BB6B, ID_VOID = 0xEC, ID_CRC32 = 0xBF;

export const MASTER_IDS = new Set([
  ID_EBML, ID_SEGMENT, ID_SEEK_HEAD, ID_INFO, ID_TRACKS, ID_TRACK_ENTRY,
  ID_CLUSTER, ID_BLOCK_GROUP, ID_CUES,
]);
