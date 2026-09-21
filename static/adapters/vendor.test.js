import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

test('webtorrent vendor bundle is pinned and present', () => {
  const versionFile = path.join(here, '..', 'vendor', 'VERSION');
  const bundleFile = path.join(here, '..', 'vendor', 'webtorrent.min.js');
  assert.ok(existsSync(versionFile), 'static/vendor/VERSION missing');
  assert.ok(existsSync(bundleFile), 'static/vendor/webtorrent.min.js missing');
  const version = readFileSync(versionFile, 'utf8').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, 'VERSION must be exact x.y.z');
  const bundle = readFileSync(bundleFile, 'utf8');
  const firstLine = bundle.split('\n', 1)[0];
  assert.ok(firstLine.includes('webtorrent@' + version), 'bundle must carry pinned version header');
  assert.ok(bundle.length > 100000, 'bundle looks truncated');
});
