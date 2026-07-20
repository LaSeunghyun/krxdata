// 지금 빈 슬롯에 적합한 hi120 후보 선정 (전략 로직 그대로) — 조회 전용, 매수는 별도
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDailyCandles, getPricesMap, getAccounts, getBuyingPower, getHoldings } from './toss-api.js';
import { allocateSlots } from './slot-alloc.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const MIN_PRICE = 2_000, LIVE_SLOTS = 2, LIVE_ATR_SIZE = 4, MIN_BREAKOUT = 3, LOOKBACK = 120;
const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
function atrMult(list) {
  if (list.length < 15) return 1;
  let tr = 0;
  for (let j = list.length - 14; j < list.length; j++) { const b = list[j], pc = list[j - 1].close; tr += Math.max(b.high - (b.low ?? b.close), Math.abs(b.high - pc), Math.abs((b.low ?? b.close) - pc)); }
  const atrPct = (tr / 14) / list[list.length - 1].close * 100;
  if (!(atrPct > 0)) return 1;
  return Math.min(1.5, Math.max(0.5, LIVE_ATR_SIZE / atrPct));
}

// 005930 레짐
const reg = (await getDailyCandles('005930', 70)).reverse();
const cl = reg.map(b => b.close); const ri = cl.length - 1;
const avg = (n) => cl.slice(ri - n + 1, ri + 1).reduce((s, v) => s + v, 0) / n;
const regime = cl[ri] > avg(20) && avg(20) > avg(60) ? 'UP' : (cl[ri] < avg(20) && (cl[ri] / cl[ri - 5] - 1) * 100 < -3 ? 'DOWN' : 'NEUTRAL');
console.log('레짐:', regime, regime !== 'UP' ? '→ UP 아니라 신규 진입 안 함(caps D)' : '');

// momUniverse (ret60 상위 30)
const uni = await dbQuery(`
  SELECT t.stock_code, sa.corp_name,
    (MAX(CASE WHEN rn=1 THEN close END)::NUMERIC / NULLIF(MAX(CASE WHEN rn=61 THEN close END),0) - 1)*100 AS ret60
  FROM (SELECT stock_code, close, ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY date DESC) AS rn
        FROM stock_prices WHERE date >= TO_CHAR(CURRENT_DATE - 180, 'YYYYMMDD')) t
  JOIN stock_analysis sa ON sa.stock_code = t.stock_code
  WHERE rn IN (1,61) AND sa.market_cap_tril >= 0.1 AND sa.current_price >= ${MIN_PRICE}
  GROUP BY t.stock_code, sa.corp_name
  HAVING (MAX(CASE WHEN rn=1 THEN close END)::NUMERIC / NULLIF(MAX(CASE WHEN rn=61 THEN close END),0) - 1)*100 > 0
  ORDER BY ret60 DESC LIMIT 30`);

// 계좌
const accts = await getAccounts(); const seq = accts[0].accountSeq;
const h = await getHoldings(seq); const heldNow = (h?.items ?? []).filter(i => i.marketCountry === 'KR').length;
const cash = Number((await getBuyingPower(seq, { currency: 'KRW' }))?.cashBuyingPower ?? 0);
const eq = Number(h?.marketValue?.amount?.krw ?? 0) + cash;
console.log(`보유 ${heldNow}슬롯 / 현금 ${cash.toLocaleString()} / equity ${eq.toLocaleString()} / 슬롯예산 ${Math.floor(eq / LIVE_SLOTS).toLocaleString()}`);

// hi120 돌파 시그널 + ATR + 현재가
const ranked = [];
for (const u of uni) {
  const list = (await getDailyCandles(u.stock_code, 130)).reverse();
  if (list.length < LOOKBACK + 2) continue;
  const i = list.length - 1;
  let prevHigh = 0; for (let j = i - LOOKBACK; j < i; j++) prevHigh = Math.max(prevHigh, list[j].high);
  if (list[i].close <= prevHigh) continue;
  const breakoutPct = (list[i].close / prevHigh - 1) * 100;
  if (breakoutPct < MIN_BREAKOUT) continue;
  const px = (await getPricesMap([u.stock_code])).get(u.stock_code)?.price ?? list[i].close;
  ranked.push({ code: u.stock_code, name: u.corp_name, price: px, atrMult: atrMult(list), breakoutPct, ret60: Number(u.ret60) });
}
console.log(`\n=== hi120 돌파 후보 ${ranked.length}개 (ret60 순) ===`);
ranked.slice(0, 8).forEach((c, k) => console.log(`${k + 1}. ${c.name}(${c.code}) 현재 ${c.price.toLocaleString()} 돌파+${c.breakoutPct.toFixed(1)}% ATR×${c.atrMult.toFixed(2)} ret60 ${c.ret60.toFixed(0)}%`));

// allocateSlots로 빈 슬롯 배분 (실제 매수할 종목/수량)
const alloc = allocateSlots(ranked, heldNow, LIVE_SLOTS, eq, cash);
console.log('\n=== 매수 배분 (allocateSlots) ===');
if (!alloc.length) console.log('(빈 슬롯 없음 또는 예산 내 매수 가능 후보 없음)');
for (const a of alloc) console.log(`▶ ${a.name}(${a.code}) ${a.qty}주 @${a.price.toLocaleString()} 지정가 = ${(a.qty * a.price).toLocaleString()}원`);
