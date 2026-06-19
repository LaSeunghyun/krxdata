#!/usr/bin/env node
/**
 * buy-now.mjs — 사용자 지시 "지금 사" 일회성 실매수 (정규장).
 *   evaluateLiveHoldings 후보선정 + executeLiveQueue 배분과 동일 규칙으로 affordable 후보를
 *   즉시 지정가 매수. 체결분은 live_meta + paper_trades(strat='live')에 기록 → 기존 매도/관리 로직이 인계.
 *   안전: LIVE_SLOTS·슬롯예산·LIVE_MAX_ORDER_VALUE 준수. 보유 슬롯만큼만. live_halt면 중단.
 *   --dry 로 계획만 출력(주문 안 함).
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAccounts, getHoldings, getBuyingPower, getDailyCandles, getOrderbook, getPricesMap, createOrder, getOrder } from './toss-api.js';
import { pickBuyCandidates, allocateSlots } from './slot-alloc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const DRY = process.argv.includes('--dry');
const SYMS_ARG = (() => { const i = process.argv.indexOf('--symbols'); return i >= 0 ? process.argv[i + 1].split(',') : null; })(); // 사용자 명시 종목만
const LIVE_SLOTS = 2, MIN_PRICE = 2000, LIVE_MAX_ORDER_VALUE = 100_000;
const COMBO_CAPS = { UP: { hi120: 6, rsi2: 4 }, NEUTRAL: { hi120: 2, rsi2: 6 }, DOWN: { hi120: 0, rsi2: 4 } };
const RSI_DAYS = 2, MIN_BREAKOUT = 3;
const kst = () => new Date(Date.now() + 9 * 3600 * 1000);
const log = (...a) => console.log('[buy-now]', ...a);

async function dbQuery(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(30_000),
  });
  const d = await r.json(); if (!Array.isArray(d)) throw new Error(d?.message ?? 'DB'); return d;
}
async function loadKey(k, dflt) { const r = await dbQuery(`SELECT data FROM paper_state WHERE k='${k}'`).catch(() => []); return r.length && r[0].data != null ? r[0].data : dflt; }
async function saveKey(k, data) { await dbQuery(`INSERT INTO paper_state (k,data,updated_at) VALUES ('${k}', $j$${JSON.stringify(data).replace(/\$/g,'')}$j$::jsonb, NOW()) ON CONFLICT (k) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()`); }
async function notify(t) { const tok=process.env.TELEGRAM_BOT_TOKEN, c=process.env.TELEGRAM_CHAT_ID; if(!tok||!c)return; await fetch(`https://api.telegram.org/bot${tok}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:c,text:t.slice(0,4000)})}).catch(()=>{}); }

const rsi2val = (c, i) => { if (i < 2) return 50; let u=0,d=0; for (let j=i-1;j<=i;j++){const ch=c[j]-c[j-1]; if(ch>0)u+=ch; else d-=ch;} return u+d===0?50:u/(u+d)*100; };
function atrMult(list){ if(!list||list.length<16)return 1; let tr=0; for(let j=list.length-14;j<list.length;j++){const b=list[j],pc=list[j-1].close; tr+=Math.max(b.high-b.low,Math.abs(b.high-pc),Math.abs(b.low-pc));} const ap=(tr/14)/list.at(-1).close*100; return ap>0?Math.min(1.5,Math.max(0.5,4/ap)):1; }
async function bars(c, n=130){ try { return (await getDailyCandles(c,n)).reverse(); } catch { return []; } }

async function regimeOf(){ const l=await bars('005930',70); if(l.length<61)return 'NEUTRAL'; const c=l.map(b=>b.close); const i=c.length-1; const avg=n=>c.slice(i-n+1,i+1).reduce((s,v)=>s+v,0)/n; const ma20=avg(20),ma60=avg(60),ret5=(c[i]/c[i-5]-1)*100; if(c[i]>ma20&&ma20>ma60)return 'UP'; if(c[i]<ma20&&ret5<-3)return 'DOWN'; return 'NEUTRAL'; }

async function main(){
  if (await loadKey('live_halt', null)) { log('live_halt 설정됨 — 중단'); return; }
  const acc = await getAccounts(); const seq = acc[0]?.accountSeq;
  const hold = await getHoldings(seq).catch(()=>null);
  const items = (hold?.items ?? []).filter(i=>i.marketCountry==='KR');
  const cash = Number((await getBuyingPower(seq,{currency:'KRW'}).catch(()=>null))?.cashBuyingPower ?? 0);
  const totalNow = Number(hold?.marketValue?.amount?.krw ?? 0) + cash;
  const slotBudget = Math.floor(totalNow / LIVE_SLOTS);
  const slotsToFill = LIVE_SLOTS - items.length;
  const regime = await regimeOf();
  const caps = COMBO_CAPS[regime];
  log(`계좌 ${acc[0].accountNo} | 현금 ${cash.toLocaleString()} | 평가 ${totalNow.toLocaleString()} | 슬롯예산 ${slotBudget.toLocaleString()} | 보유 ${items.length} | 빈슬롯 ${slotsToFill} | 레짐 ${regime}`);
  if (slotsToFill <= 0) { log('빈 슬롯 없음 — 매수 안 함'); return; }

  const affordable = (close) => close*1.01 <= slotBudget; // 풀 슬롯예산 기준 1주 가능?(ATR는 수량만, allocateSlots 1주 floor)
  const seen = new Set(items.map(i=>i.symbol));
  const ranked = [];

  // ── 사용자 명시 종목 모드 (--symbols): 스크리닝 없이 지정 종목만 매수 (사용자가 정확히 승인) ──
  if (SYMS_ARG) {
    for (const code of SYMS_ARG) {
      if (seen.has(code)) { log(`이미 보유 — ${code} 스킵`); continue; }
      const row = (await dbQuery(`SELECT corp_name FROM stock_analysis WHERE stock_code='${code}'`).catch(()=>[]))[0];
      const l = await bars(code, 20);
      const c = l.map(b=>b.close); const r2 = c.length>=3 ? rsi2val(c, c.length-1) : null;
      // 사용자 명시 픽 — 자동 ATR 축소 미적용(슬롯 예산 1.0배), 다만 관리용 실제 atrMult는 ctx에 보존
      ranked.push({ code, name: row?.corp_name ?? code, close: l.at(-1)?.close ?? 0, atrMult: 1, realAtr: atrMult(l), sub: 'rsi2', rsi: r2 ?? 0 });
    }
  } else {
  // hi120 (UP) — momentum 유니버스 신고가 돌파 + affordable
  if (regime === 'UP' && caps.hi120 > 0) {
    const mom = await dbQuery(`SELECT t.stock_code, sa.corp_name FROM (SELECT stock_code,close,ROW_NUMBER() OVER(PARTITION BY stock_code ORDER BY date DESC) rn FROM stock_prices WHERE date>=TO_CHAR(CURRENT_DATE-180,'YYYYMMDD')) t JOIN stock_analysis sa ON sa.stock_code=t.stock_code WHERE rn IN(1,61) AND sa.market_cap_tril>=0.1 AND sa.current_price>=${MIN_PRICE} GROUP BY t.stock_code,sa.corp_name HAVING (MAX(CASE WHEN rn=1 THEN close END)::NUMERIC/NULLIF(MAX(CASE WHEN rn=61 THEN close END),0)-1)*100>0 ORDER BY (MAX(CASE WHEN rn=1 THEN close END)::NUMERIC/NULLIF(MAX(CASE WHEN rn=61 THEN close END),0)-1)*100 DESC LIMIT 30`).catch(()=>[]);
    for (const u of mom) {
      if (seen.has(u.stock_code)) continue;
      const l = await bars(u.stock_code); if (l.length<122) continue;
      const i=l.length-1; let ph=0; for(let j=i-120;j<i;j++)ph=Math.max(ph,l[j].high);
      const bpct=(l[i].close/ph-1)*100;
      if (l[i].close>ph && bpct>=MIN_BREAKOUT) { const am=atrMult(l); if(!affordable(l[i].close)){log(`hi120 제외(예산): ${u.corp_name} ${l[i].close.toLocaleString()}`);continue;} ranked.push({code:u.stock_code,name:u.corp_name,close:l[i].close,atrMult:am,sub:'hi120',breakoutPct:bpct}); seen.add(u.stock_code); }
      if (ranked.length>=slotsToFill+3) break;
    }
  }
  // rsi2 — 우량중저가 유니버스 과매도 + affordable
  if (caps.rsi2 > 0) {
    const ceil = Math.max(slotBudget, MIN_PRICE*3);
    const uni = await dbQuery(`SELECT stock_code,corp_name FROM stock_analysis WHERE current_price>=${MIN_PRICE} AND current_price<=${ceil} AND market_cap_tril>=0.3 ORDER BY market_cap_tril DESC LIMIT 40`).catch(()=>[]);
    for (const r of uni) {
      if (seen.has(r.stock_code)) continue;
      const l = await bars(r.stock_code,10); if(l.length<5)continue;
      const c=l.map(b=>b.close); const cur=rsi2val(c,c.length-1), prev=rsi2val(c,c.length-2);
      if (cur<10 && (RSI_DAYS<2 || prev<10)) { const am=atrMult(l); if(!affordable(c.at(-1))){continue;} ranked.push({code:r.stock_code,name:r.corp_name,close:c.at(-1),atrMult:am,sub:'rsi2',rsi:cur}); seen.add(r.stock_code); }
      if (ranked.length>=slotsToFill+5) break;
    }
  }
  } // end screening (non --symbols)

  const candidates = pickBuyCandidates(ranked, new Set(), slotsToFill + 3);
  // 현재가(지정가용 호가) 부여
  const priced = [];
  for (const c of candidates) {
    const ob = await getOrderbook(c.code).catch(()=>null);
    const ask = ob?.asks?.[0]?.price ? Number(ob.asks[0].price) : (Number((await getPricesMap([c.code])).get(c.code)?.price) || c.close);
    priced.push({ ...c, price: ask });
  }
  const alloc = allocateSlots(priced, items.length, LIVE_SLOTS, totalNow, cash);

  console.log('\n=== 매수 계획 ===');
  if (!alloc.length) { console.log('  배분된 매수 없음 (예산/후보 부족)'); return; }
  for (const a of alloc) { const p=priced.find(x=>x.code===a.code); console.log(`  ${a.name}(${a.code}) ${a.qty}주 @${a.price.toLocaleString()} = ${(a.qty*a.price).toLocaleString()}원 [${p.sub}${p.sub==='rsi2'?` RSI2 ${Math.round(p.rsi)}`:` 돌파+${p.breakoutPct.toFixed(1)}%`}, ATR×${p.atrMult.toFixed(2)}]`); }
  if (DRY) { console.log('\n--dry: 주문 미실행'); return; }

  const meta = await loadKey('live_meta', {});
  let bought = 0;
  for (const a of alloc) {
    if (a.price * a.qty > LIVE_MAX_ORDER_VALUE) { log(`상한 초과 스킵 ${a.name}`); continue; }
    const p = priced.find(x=>x.code===a.code);
    try {
      const order = await createOrder(seq, { symbol: a.code, side:'BUY', orderType:'LIMIT', price:String(a.price), quantity:String(a.qty) });
      // 체결 대기 (최대 90초)
      let fill=null; const t0=Date.now();
      while (Date.now()-t0<90_000) { const o=await getOrder(seq, order.orderId).catch(()=>null); if(o?.status==='FILLED'){fill=o;break;} if(['REJECTED','CANCELED'].includes(o?.status))break; await new Promise(r=>setTimeout(r,3000)); }
      const fp = Number(fill?.filledPrice ?? fill?.averageFilledPrice ?? a.price);
      const filled = !!fill;
      const ctx = p.sub==='hi120' ? {sub:'hi120',regime,breakoutPct:p.breakoutPct.toFixed(1),atrMult:p.atrMult.toFixed(2)} : {sub:'rsi2',regime,rsi:Math.round(p.rsi).toString(),atrMult:p.atrMult.toFixed(2)};
      await dbQuery(`INSERT INTO paper_trades (ts,strat,type,code,name,qty,price,reason,ctx) VALUES (NOW(),'live','buy','${a.code}',$s$${a.name}$s$,${a.qty},${fp},$s$지금 사(수동) ${ctx.sub}$s$,$j$${JSON.stringify(ctx)}$j$::jsonb)`);
      meta[a.code] = { sub: ctx.sub, name: a.name, entry: fp, entryDay: kst().toISOString().slice(0,10).replace(/-/g,''), hi: fp, holdDays: 0, ctx };
      bought++;
      log(`${filled?'💰 체결':'⏳ 주문(미체결 대기)'} ${a.name} ${a.qty}주 @${fp.toLocaleString()}`);
      await notify(`💰 [수동 매수] ${a.name} ${a.qty}주 @${fp.toLocaleString()}원 (${ctx.sub}${ctx.sub==='rsi2'?` RSI2 ${ctx.rsi}`:` 돌파+${ctx.breakoutPct}%`})\n총 ${(a.qty*fp).toLocaleString()}원${filled?'':' — 미체결, 호가 확인 필요'}`);
    } catch(e) { log(`주문 오류 ${a.name}: ${e.message}`); await notify(`⛔ [수동 매수 오류] ${a.name}: ${e.message}`); }
  }
  await saveKey('live_meta', meta);
  log(`완료 — ${bought}건 주문`);
}
main().catch(e=>{ console.error('[buy-now 오류]', e); process.exit(1); });
