import test from 'node:test';
import assert from 'node:assert/strict';
import { readVint, readElementHeader } from './ebml.js';

test('vint 1-byte', () => {
  const { value, size } = readVint(new Uint8Array([0x8A]), 0);
  assert.equal(value, 0x0A); assert.equal(size, 1);
});

test('vint 2-byte id keeps marker', () => {
  // element id 0xA3 encoded as 2 bytes: 0x40|0x00 , 0xA3 → 0x40A3? no:
  // ids are read with keepMarker=true: 0x1F 0x43 ... for cluster is 4-byte
  const buf = new Uint8Array([0x1F, 0x43, 0xB6, 0x75]);
  const { value, size } = readVint(buf, 0, true);
  assert.equal(value, 0x1F43B675); assert.equal(size, 4);
});

test('element header', () => {
  // SimpleBlock id A3 (1 byte), size 0x85 = 5
  const buf = new Uint8Array([0xA3, 0x85, 1, 2, 3, 4, 5]);
  const h = readElementHeader(buf, 0);
  assert.equal(h.id, 0xA3); assert.equal(h.size, 5); assert.equal(h.headerSize, 2);
});

test('unknown size', () => {
  const buf = new Uint8Array([0x1F, 0x43, 0xB6, 0x75, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  // 8-byte vint all-ones after marker = unknown (-1)
  // buf = Cluster ID (4B) + unknown-size vint (8B): header starts at 0
  const h = readElementHeader(buf, 0);
  assert.equal(h.id, 0x1F43B675);
  assert.equal(h.size, -1);
  assert.equal(h.headerSize, 12);
});
