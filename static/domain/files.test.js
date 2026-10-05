import test from 'node:test';
import assert from 'node:assert/strict';
import { playableFiles, groupByFolder, nextFile, isPlayable } from './files.js';

// Season-pack layout, deliberately out of order (torrent order is arbitrary).
const pack = [
  { index: 0, path: 'TBBT/Season 10/TBBT.S10E10.mp4', size: 300 },
  { index: 1, path: 'TBBT/Season 1/TBBT.S01E02.mp4', size: 200 },
  { index: 2, path: 'TBBT/Season 1/TBBT.S01E10.mp4', size: 210 },
  { index: 3, path: 'TBBT/Season 1/TBBT.S01E01.mp4', size: 190 },
  { index: 4, path: 'TBBT/Season 2/TBBT.S02E01.mkv', size: 250 },
  { index: 5, path: 'TBBT/Season 1/TBBT.S01E01.rus.srt', size: 1 },
  { index: 6, path: 'TBBT/Farewell.Special.mp4', size: 400 },
];

test('playableFiles: videos only, natural order (E2 before E10, Season 2 before 10)', () => {
  assert.deepEqual(playableFiles(pack).map((f) => f.index), [6, 3, 1, 2, 4, 0]);
  assert.ok(!isPlayable(pack[5]));
});

test('groupByFolder: drops the common top folder, groups per season', () => {
  const g = groupByFolder(pack);
  assert.deepEqual(g.map((x) => [x.folder, x.files.map((f) => f.index)]), [
    ['', [6]],
    ['Season 1', [3, 1, 2]],
    ['Season 2', [4]],
    ['Season 10', [0]],
  ]);
});

test('nextFile follows the natural order across seasons', () => {
  assert.equal(nextFile(pack, 2).index, 4); // S01E10 → S02E01
  assert.equal(nextFile(pack, 4).index, 0); // S02E01 → S10E10
  assert.equal(nextFile(pack, 0), null); // last
  assert.equal(nextFile(pack, 5), null); // not a video
});

test('continueTarget: last played, or the next one when it was finished', async () => {
  const { continueTarget } = await import('./files.js');
  assert.equal(continueTarget(pack, 1, false).index, 1); // S01E02, in progress
  assert.equal(continueTarget(pack, 1, true).index, 2); // finished → S01E10
  assert.equal(continueTarget(pack, 0, true).index, 0); // last of the series stays
  assert.equal(continueTarget(pack, null, false), null); // nothing played yet
  assert.equal(continueTarget(pack, 99, false), null); // file no longer there
});
