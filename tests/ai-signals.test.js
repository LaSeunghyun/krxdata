import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSignals } from '../ai-signals.mjs';

test('assembleSignals attaches compact cached news from provider', async () => {
  const queries = [];
  const rowsBySql = [
    [{ stock_code: '005930', corp_name: '삼성전자', sector: '반도체', current_price: 90000, total_score: 77, short_score: 70, long_score: 80, recommendation: 'buy', short_target_pct: 5, mid_target_pct: 12, high_52w: 100000, low_52w: 60000, market_cap_tril: 500, avg_turnover_20d: 100000000000, bonus_flag: false }],
    [{ rcept_no: '20260723000001', rcept_dt: '2026-07-23', report_nm: '단일판매ㆍ공급계약체결' }],
    [{ close: 80 }, { close: 90 }, { close: 100 }, { close: 110 }, { close: 120 }, { close: 130 }],
    [{ date: '2026-07-22', frgn_amt_mil: 1, orgn_amt_mil: 2, prsn_amt_mil: -3 }],
  ];
  const dbQuery = async (sql) => {
    queries.push(sql);
    return rowsBySql.shift() ?? [];
  };

  const sig = await assembleSignals('005930', {
    dbQuery,
    withDetail: false,
    newsProvider: async ({ code, name }) => [{
      title: `${name} 뉴스`,
      source: '예시경제',
      link: `https://example.com/${code}`,
      published: '2026-07-23T00:00:00.000Z',
      snippet: '짧은 요약',
    }],
  });

  assert.equal(queries.length, 4);
  assert.deepEqual(sig.news, [{
    title: '삼성전자 뉴스',
    source: '예시경제',
    link: 'https://example.com/005930',
    published: '2026-07-23T00:00:00.000Z',
    snippet: '짧은 요약',
  }]);
});

