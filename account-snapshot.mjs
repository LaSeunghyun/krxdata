#!/usr/bin/env node
/**
 * account-snapshot.mjs — 계좌 스냅샷을 Supabase 에 적재 (2026-08-16, 사용자 5대 목표의 공통 선행 작업)
 *
 * 왜: 아침 브리핑 보유종목 섹션·데일리 복기·대시보드가 전부 "지금 보유가 뭔지"를 알아야 하는데,
 *     그 정보가 VM 의 stock-live 프로세스 안에만 있었다. 여기서 10분마다 DB 로 내보낸다.
 *
 * 적재:
 *   - account_snapshots (append, 자산곡선용): ts · equity · cash · positions jsonb
 *   - paper_state 'account:latest' (upsert, 최신 1건 빠른 조회용 — 브리핑·복기가 읽는다)
 *
 * 손절/트레일 레벨은 status.mjs 와 동일 산식 (stock-live-state.json meta + strategy-contract).
 *   sub 없음 = 봇이 자동청산하지 않는 포지션 — 화면에 그대로 정직하게 표기한다.
 *
 * Toss 부하: getHoldings + getBuyingPower = 10분당 2콜 (레이트리밋·경합 무시 수준, 401 재시도는 tossGet 내장).
 * 실행: node account-snapshot.mjs [--force]  (--force = 휴장일에도 1회 적재 — 부트스트랩용)
 * 크론(UTC): 별도 등록 — KST 08:00~20:00 평일 10분 주기.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const { getAccounts, getHoldings, getBuyingPower } = await import('./toss-api.js');
const { isTradingDayKST } = await import('./market-day.mjs');
const { PARTIAL_TP, HARD_STOP_PCT, TRAIL_PCT } = await import('./strategy-contract.mjs');

const FORCE = process.argv.includes('--force');
const now = () => new Date(Date.now() + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`[snap ${now().slice(11)}] ${m}`);
const q = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`,
    { method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(`db: ${JSON.stringify(j).slice(0, 150)}`);
  return j;
};
// paper_state.data 저장용 — forecast-run jsonb() 와 동일하게 $ 제거로 달러쿼팅 보호
const jsonb = (o) => `$j$${JSON.stringify(o).replace(/\$/g, '')}$j$::jsonb`;

async function main() {
  if (!FORCE && !(await isTradingDayKST())) { log('휴장일 — 종료'); return; }

  const seq = (await getAccounts())[0]?.accountSeq;
  if (seq == null) { log('계좌 조회 실패 — 종료'); process.exit(1); }
  const h = await getHoldings(seq);
  const bp = await getBuyingPower(seq, { currency: 'KRW' });
  const cash = Number(bp?.cashBuyingPower ?? 0);

  const stPath = join(__dirname, 'stock-live-state.json');
  const meta = existsSync(stPath) ? (JSON.parse(readFileSync(stPath, 'utf8')).meta ?? {}) : {};

  const items = (h?.items ?? []).filter(i => i.marketCountry === 'KR' && Number(i.quantity) > 0);
  let mv = 0;
  const positions = items.map((it) => {
    const qty = Number(it.quantity), avg = Number(it.averagePurchasePrice), cur = Number(it.lastPrice);
    mv += qty * cur;
    const m = meta[it.symbol] ?? {};
    const sub = m.sub ?? null;
    const p = { code: it.symbol, name: it.name, qty, avg, cur, ret_pct: Math.round((cur / avg - 1) * 1000) / 10, sub };
    if (sub === 'rsi2') {
      p.stop = Math.round(avg * (1 - HARD_STOP_PCT / 100));           // 하드손절 (트레일 없음 — 2026-07-29 장중개입 폐지)
    } else if (sub) {
      const hi = m.hi ?? cur;
      const trP = m.trailPct ?? TRAIL_PCT;
      p.trail = Math.round(hi * (1 - trP / 100));                     // 트레일 (갭정책 meta 오버라이드 반영)
      p.hi = hi;
      p.tp = [m.tp1Pct ?? PARTIAL_TP.tp1Pct, m.tp2Pct ?? PARTIAL_TP.tp2Pct];
    } // sub 없음 = 자동청산 없음 — 레벨 필드 자체를 두지 않는다(없는 손절선을 있는 것처럼 보이면 안 됨)
    return p;
  });
  const equity = Math.round(mv + cash);

  await q(`CREATE TABLE IF NOT EXISTS account_snapshots (
    id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(),
    equity numeric, cash numeric, positions jsonb)`);
  await q(`INSERT INTO account_snapshots (equity, cash, positions) VALUES (${equity}, ${cash}, ${jsonb(positions)})`);
  await q(`INSERT INTO paper_state (k, data, updated_at)
    VALUES ('account:latest', ${jsonb({ ts: now(), equity, cash, positions })}, NOW())
    ON CONFLICT (k) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`);
  // 보존 기간 90일 — 자산곡선엔 충분, 무한 성장 방지
  await q(`DELETE FROM account_snapshots WHERE ts < now() - interval '90 days'`);
  log(`적재: 평가 ${equity.toLocaleString()}원 (현금 ${cash.toLocaleString()}) · 보유 ${positions.length}종목`);

  // ── 저널 → live_trades 동기화 (대시보드 매매 피드용, 2026-08-17) ──────────
  // 저널은 VM 로컬 파일이라 UI(아티팩트)가 못 읽는다. 멱등 upsert 로 DB 에 미러링.
  // PK (ts, code, side) — 같은 초에 같은 종목 같은 방향 재체결은 저널 구조상 없다.
  try {
    const jrPath = join(__dirname, 'stock-live-journal.json');
    const trades = existsSync(jrPath) ? (JSON.parse(readFileSync(jrPath, 'utf8')).trades ?? []) : [];
    if (trades.length) {
      await q(`CREATE TABLE IF NOT EXISTS live_trades (
        ts timestamptz, code text, name text, side text, px numeric, qty int,
        ret numeric, reason text, sub text, PRIMARY KEY (ts, code, side))`);
      const esc = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
      const num = (v) => (v == null || Number.isNaN(Number(v)) ? 'NULL' : Number(v));
      const vals = trades
        .filter(t => t.ts && t.code && t.side)
        .map(t => `('${String(t.ts).replace(' ', 'T')}+09:00', ${esc(t.code)}, ${esc(t.name)}, ${esc(t.side)}, ${num(t.px)}, ${num(t.qty)}, ${num(t.ret)}, ${esc(t.reason)}, ${esc(t.sub)})`);
      for (let i = 0; i < vals.length; i += 200) {
        await q(`INSERT INTO live_trades (ts, code, name, side, px, qty, ret, reason, sub)
          VALUES ${vals.slice(i, i + 200).join(',')} ON CONFLICT (ts, code, side) DO NOTHING`);
      }
      log(`live_trades 동기화 ${vals.length}건 (멱등)`);
    }
  } catch (e) { log(`live_trades 동기화 실패(비치명): ${e.message}`); }
}
main().catch((e) => { log(`오류: ${e.message}`); process.exit(1); });
