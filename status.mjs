#!/usr/bin/env node
/**
 * status.mjs — 읽기전용 상태 요약 (계좌·포지션·손절선·최신예측·skill게이트). 주문/쓰기 없음.
 *   텔레그램 봇/vm 헬퍼가 안전하게 호출하는 read-only 창구.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getAccounts, getHoldings, getBuyingPower } from './toss-api.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  const j = await r.json(); return Array.isArray(j) ? j : [];
};

try {
  const seq = (await getAccounts())[0].accountSeq;
  const h = await getHoldings(seq);
  const bp = await getBuyingPower(seq, { currency: 'KRW' });
  const st = existsSync(join(__dirname, 'stock-live-state.json')) ? JSON.parse(readFileSync(join(__dirname, 'stock-live-state.json'), 'utf8')) : { meta: {} };
  const items = (h?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0);
  let mv = 0;
  console.log('=== 보유 포지션 ===');
  for (const it of items) {
    const qty = Number(it.quantity), avg = Number(it.averagePurchasePrice), last = Number(it.lastPrice);
    const hi = st.meta?.[it.symbol]?.hi ?? last, eff = Math.max(avg * 0.93, hi * 0.92);
    mv += qty * last;
    console.log(`${it.name}(${it.symbol}) ${qty}주 @${avg.toLocaleString()} → ${last.toLocaleString()} (${(last / avg - 1) * 100 >= 0 ? '+' : ''}${((last / avg - 1) * 100).toFixed(1)}%) 손절선 ${Math.round(eff).toLocaleString()} 여유 ${((last / eff - 1) * 100).toFixed(1)}%`);
  }
  const cash = Number(bp?.cashBuyingPower ?? 0);
  console.log(`현금 ${cash.toLocaleString()} | 평가 ${mv.toLocaleString()} | 총 ${(mv + cash).toLocaleString()} (원금 714,306 대비 ${(((mv + cash) / 714306 - 1) * 100).toFixed(2)}%)`);
  const fc = await q(`SELECT sector,call_direction,probability_up,probability_down,confidence FROM forecast_ledger WHERE target_kind='market' AND sector IN ('KOSPI_PROXY','KOSDAQ_PROXY') ORDER BY forecast_created_at DESC LIMIT 2`);
  console.log('\n=== 최신 시장예측 ===');
  for (const f of fc) console.log(`${f.sector} ${f.call_direction} (상승${f.probability_up}/하락${f.probability_down} conf${f.confidence})`);
} catch (e) { console.error('status 오류:', e.message); process.exit(1); }
