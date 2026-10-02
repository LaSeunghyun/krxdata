import test from 'node:test';
import assert from 'node:assert/strict';
import { sectorField, groupByKeySet, warnWrite, writeFailures } from '../scoring-core.js';

test('sectorField: 맵에 섹터가 있으면 sector 키를 넣는다', () => {
  assert.deepEqual(sectorField({ '005930': { sector: '반도체·전자부품' } }, '005930'), { sector: '반도체·전자부품' });
});

test('sectorField 음성 대조: 맵에 없거나 비어 있으면 sector 키 자체가 없다 (null 로 덮어쓰지 않음)', () => {
  const row = { stock_code: '111110', ...sectorField({}, '111110') };
  assert.equal('sector' in row, false);
  assert.equal('sector' in { ...sectorField({ A: { sector: '' } }, 'A') }, false);
  assert.equal('sector' in { ...sectorField(undefined, 'A') }, false);
});

test('groupByKeySet: sector 키가 있는 행과 없는 행을 서로 다른 요청으로 나눈다', () => {
  const rows = [
    { stock_code: 'A', total_score: 1, sector: 's' },
    { stock_code: 'B', total_score: 2 },
    { stock_code: 'C', total_score: 3, sector: 't' },
  ];
  const g = groupByKeySet(rows);
  assert.equal(g.length, 2);
  for (const part of g) {
    const keys = new Set(part.map((r) => Object.keys(r).sort().join('|')));
    assert.equal(keys.size, 1); // 한 요청 안에서는 키 집합이 동일 -> 빠진 키가 NULL 로 채워지지 않는다
  }
  assert.equal(g.flat().length, 3);
});

test('warnWrite: 실패 횟수를 센다 (스크립트가 exit 1 판정에 사용)', () => {
  const before = writeFailures.count;
  const orig = console.warn; console.warn = () => {};
  try { warnWrite('x'); warnWrite('y'); } finally { console.warn = orig; }
  assert.equal(writeFailures.count, before + 2);
});
