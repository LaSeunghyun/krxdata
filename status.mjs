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
import { PARTIAL_TP, HARD_STOP_PCT, TRAIL_PCT } from './strategy-contract.mjs';
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
  // ⚠️ state 는 **라이브 봇이 도는 머신(VM)에만** 있다. 로컬 실행이면 meta 가 통째로 비어
  //    모든 포지션이 "sub없음"으로 보인다 = 실제로는 손절이 걸린 종목을 없다고 보고하는 거짓 경보.
  //    "meta 가 없다"와 "state 파일이 없다"는 다른 사건이므로 구분해서 알린다(추론으로 메우지 않는다).
  const stPath = join(__dirname, 'stock-live-state.json');
  const hasState = existsSync(stPath);
  const st = hasState ? JSON.parse(readFileSync(stPath, 'utf8')) : { meta: {} };
  if (!hasState) console.log('⚠️ stock-live-state.json 없음 — 전략 메타를 못 읽는다. 아래 청산 규칙 표시는 무의미하다.\n   정확한 값은 VM 에서: ssh ... "cd ~/krxdata && node status.mjs"\n');
  const items = (h?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0);
  let mv = 0;
  console.log('=== 보유 포지션 ===');
  for (const it of items) {
    const qty = Number(it.quantity), avg = Number(it.averagePurchasePrice), last = Number(it.lastPrice);
    const m = st.meta?.[it.symbol];
    const sub = m?.sub ?? null;
    const hi = m?.hi ?? last;
    const pct = (a, b) => `${(a / b - 1) * 100 >= 0 ? '+' : ''}${((a / b - 1) * 100).toFixed(1)}%`;
    let guard;
    if (!sub) {
      // stock-live.mjs:1169 `else if (!m.sub)` 는 경보만 내고 reason 을 세우지 않는다.
      // else-if 체인이라 하드손절(:1177)·트레일(:1178)에 **도달하지 못하고**,
      // judgeExitsAtClose(:705) 도 `m.sub !== 'rsi2' && !== 'hi120'` 로 스킵한다. = 자동청산 0개.
      guard = '손절선 없음 ⚠️ 자동청산 보류(전략 미상 — 봇이 팔지 않습니다)';
    } else if (sub === 'rsi2') {
      // rsi2 는 트레일이 없다(2026-07-29 장중개입 폐지). 하드손절 / MA3 회귀 익절 / 5거래일 만기뿐.
      const stop = avg * (1 - HARD_STOP_PCT / 100);
      guard = `하드손절 ${Math.round(stop).toLocaleString()} (여유 ${pct(last, stop)}) · 트레일 없음 · MA3익절/5일만기`;
    } else {
      // hi120 은 트레일 + 부분익절. 갭정책(G1/G2)이 진입 시점에 meta 로 고정 저장돼 여기만 오버라이드한다.
      const trP = m.trailPct ?? TRAIL_PCT, tp1 = m.tp1Pct ?? PARTIAL_TP.tp1Pct, tp2 = m.tp2Pct ?? PARTIAL_TP.tp2Pct;
      const tr = hi * (1 - trP / 100);
      guard = `트레일 ${Math.round(tr).toLocaleString()} (고점 ${Math.round(hi).toLocaleString()} -${trP}%${m.gapBin ? `/${m.gapBin}` : ''}, 여유 ${pct(last, tr)}) · 익절 +${tp1}/+${tp2}%`;
    }
    mv += qty * last;
    console.log(`${it.name}(${it.symbol}) ${qty}주 @${avg.toLocaleString()} → ${last.toLocaleString()} (${pct(last, avg)}) [${sub ?? 'sub없음'}] ${guard}`);
  }
  const cash = Number(bp?.cashBuyingPower ?? 0);
  // ⚠️ 714,306 은 2026-07-21 최초 이전액이고 그 뒤 입금이 반영되지 않는다(코드베이스 전체에서 이 줄에만 있는 리터럴,
  //    toss-api.js 에 입출금 조회 함수 없음). 이 값으로 나눈 수익률은 의미가 없어 표시하지 않는다.
  //    실제 성과 측정은 live_equity 일별 적재가 선행돼야 한다 — 소급 복원은 불가능하다(2026-08-08 감사).
  console.log(`현금 ${cash.toLocaleString()} | 평가 ${mv.toLocaleString()} | 총 ${(mv + cash).toLocaleString()} (수익률 미산출 — 입금 이력 원장 없음. 최초 이전액 714,306 참고)`);
  const fc = await q(`SELECT sector,call_direction,probability_up,probability_down,confidence FROM forecast_ledger WHERE target_kind='market' AND sector IN ('KOSPI_PROXY','KOSDAQ_PROXY') ORDER BY forecast_created_at DESC LIMIT 2`);
  console.log('\n=== 최신 시장예측 ===');
  for (const f of fc) console.log(`${f.sector} ${f.call_direction} (상승${f.probability_up}/하락${f.probability_down} conf${f.confidence})`);
} catch (e) { console.error('status 오류:', e.message); process.exit(1); }
