import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCorpCodeXml } from '../dart-financials-backfill.js';
import { isCommonStockCode, diffUniverse, SECTOR_STATS_SQL } from '../refresh-master.mjs';

const XML = `<result>
<list><corp_code>00000001</corp_code><corp_name>비상장A</corp_name><stock_code> </stock_code></list>
<list><corp_code>00000002</corp_code><corp_name>비상장B</corp_name><stock_code> </stock_code></list>
<list><corp_code>00119195</corp_code><corp_name>상장C</corp_name><stock_code>000020</stock_code></list>
<list><corp_code>00000003</corp_code><corp_name>비상장D</corp_name><stock_code> </stock_code></list>
<list><corp_code>00126380</corp_code><corp_name>상장E</corp_name><stock_code>005930</stock_code></list>
</result>`;

test('parseCorpCodeXml: 비상장 항목이 섞여도 corp_code 가 상장사와 정확히 짝지어진다', () => {
  assert.deepEqual(parseCorpCodeXml(XML), { '000020': '00119195', '005930': '00126380' });
});

test('음성 대조: 구 정규식은 같은 입력에서 틀린 매핑을 낸다 (회귀 감시용)', () => {
  const old = {};
  const re = /<list>[\s\S]*?<corp_code>(\d+)<\/corp_code>[\s\S]*?<stock_code>(\d+)<\/stock_code>[\s\S]*?<\/list>/g;
  let m;
  while ((m = re.exec(XML)) !== null) old[m[2]] = m[1];
  assert.notEqual(old['000020'], '00119195');
});

test('isCommonStockCode: 보통주만 통과 (우선주·리츠·영문혼합 제외)', () => {
  assert.equal(isCommonStockCode('005930'), true);
  assert.equal(isCommonStockCode('005935'), false);
  assert.equal(isCommonStockCode('00088K'), false);
  assert.equal(isCommonStockCode('0030R0'), false);
});

test('diffUniverse: 신규 보통주만 added, DB 에만 있는 종목은 missing (값 변경 없음)', () => {
  const api = [{ c: '000020' }, { c: '111110' }, { c: '111115' }];
  const { added, missing } = diffUniverse(api, ['000020', '999990']);
  assert.deepEqual(added.map((x) => x.c), ['111110']);
  assert.deepEqual(missing, ['999990']);
});

test('sector_stats SQL 은 추가 전용 UPSERT 이고 삭제·TRUNCATE 를 쓰지 않는다', () => {
  assert.match(SECTOR_STATS_SQL, /ON CONFLICT \(sector, mrkt_ctg\) DO UPDATE/);
  assert.doesNotMatch(SECTOR_STATS_SQL, /DELETE|TRUNCATE|DROP/i);
});
