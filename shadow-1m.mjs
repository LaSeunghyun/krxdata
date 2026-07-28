/**
 * shadow-1m.mjs — 1분봉 룰의 **라이브 섀도우 시뮬레이션** (2026-07-27, 사용자 요청 "라이브로 계속 시뮬레이션")
 * 실주문 없음. 목적은 "지금 없는 것 = 표본"을 매일 쌓는 것.
 *
 * 두 가지를 적재한다.
 *  1) shadow_1m_metrics — **유동성통과 전 종목 × 매일 1행**의 분봉 파생 지표(원시 분봉의 1/250 용량).
 *     결과(3·5·10일 수익률)는 나중에 일봉으로 조인해 계산 → 판별자 검증의 영구 표본.
 *  2) shadow_1m_positions — 룰변형(A/B/C)별 상위 종목의 페이퍼 진입·청산. 라이브 청산룰과 동일
 *     (하드 -7% / 고점대비 트레일 -6% / +6%·+12% 절반 부분익절 / 최대 10거래일).
 *
 * ⚠️ 사전 기대값은 음수다: 같은 조건을 일봉으로 3.4년 소급하면 날짜매칭 랜덤보다 열세였다
 *    (UP -0.50%p / NEUTRAL -0.15%p / DOWN -1.33%p). 이 섀도우가 검증하는 건 그 측정이 담을 수 없었던
 *    **분봉 고유 부분**(VWAP 기울기·저점상승·되돌림)이다. 결과가 음수로 나오는 것도 정상적인 결론이다.
 *
 * 실행: node shadow-1m.mjs --snapshot   (장중, 보통 15:20 KST — 전 종목 지표 적재 + 페이퍼 진입)
 *       node shadow-1m.mjs --settle     (장마감 후/다음날 — 열린 페이퍼 포지션 청산 판정)
 *       node shadow-1m.mjs --report     (누적 성적)
 */
import 'dotenv/config';
import { scanNow } from './scan-1m-core.mjs';
import { getDailyPrices } from './kis-api.js';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const TOPN = Number(argOf('--topn', 3));       // 룰별 페이퍼 진입 종목수
const MAXN = Number(argOf('--max', 0));
// 청산룰 변형(2026-07-27) — watch-1m.mjs와 동일 정의여야 한다. 진입 시 절대%로 확정해 행에 저장.
const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const EXITS = {
  base: () => ({ trail: 6, hard: 7, tp1: 6, tp2: 12, maxHold: 10 }),
  atr: (a) => ({ trail: cl(1.5 * a, 3, 12), hard: cl(2.0 * a, 4, 14), tp1: cl(1.5 * a, 3, 12), tp2: cl(3.0 * a, 6, 24), maxHold: 10 }),
  tight: () => ({ trail: 3, hard: 4, tp1: 3, tp2: 6, maxHold: 5 }),
};
// 왕복 비용(%p): 수수료 1.5bp×2 + 거래세 20bp + 슬리피지 ±1틱 ≈ 0.33%p. 백테 엔진과 같은 전제.
//   부분익절로 매도가 여러 번 나뉘어도 수수료·세금은 매도금액 비례라 총액은 같다 → 상수 1회 차감으로 근사.
const COST = 0.33;
const log = (m) => console.log(`[${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}] ${m}`);

const dbQuery = async (sql) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(4) : 'NULL');
const kstDate = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
// 종목명 맵 (DB에 &amp; 등 HTML 엔티티가 섞여 있어 디코드 필요)
const NAME = new Map();
const loadNames = async () => {
  if (NAME.size) return;
  try {
    for (const r of await dbQuery('SELECT stock_code, corp_name FROM stocks')) {
      NAME.set(r.stock_code, String(r.corp_name ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    }
  } catch { /* 실패 시 코드로 표기 */ }
};
const nm = (c) => (NAME.get(c) ? `${NAME.get(c)}(${c})` : c);
// 텔레그램 보고는 기본 OFF (2026-07-27 사용자 요청). 필요하면 --tg 로 켠다. 로그·--report엔 그대로 남는다.
const TG = argv.includes('--tg');
const tgSend = async (t) => {
  if (!TG) return;
  const T = process.env.TELEGRAM_BOT_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
  if (!T || !C) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: C, text: t }) });
    if (!r.ok) log(`텔레그램 전송 실패 ${r.status}`);
  } catch (e) { log(`텔레그램 오류: ${String(e.message).slice(0, 50)}`); }
};

async function ensureTables() {
  await dbQuery(`CREATE TABLE IF NOT EXISTS shadow_1m_metrics (
    d date NOT NULL, stock_code text NOT NULL, hhmm text,
    px numeric, day_ret numeric, vwap_prem numeric, pos numeric, higher_lows int,
    vwap_slope numeric, up_bars numeric, up_vol_frac numeric, pullback numeric,
    atr1 numeric, vol_pace numeric, hi_prox numeric, rs20 numeric,
    self_up boolean, score_ab numeric, score_c numeric,
    PRIMARY KEY (d, stock_code, hhmm))`);
  // 2026-07-27: 관측창을 당일 전 구간으로 확대하며 구조 지표 추가 (분봉은 당일만 조회 가능 = 소급 불가)
  await dbQuery(`ALTER TABLE shadow_1m_metrics
    ADD COLUMN IF NOT EXISTS open_gap numeric, ADD COLUMN IF NOT EXISTS am_break boolean,
    ADD COLUMN IF NOT EXISTS pullback60 numeric, ADD COLUMN IF NOT EXISTS vwap_slope60 numeric,
    ADD COLUMN IF NOT EXISTS bars int, ADD COLUMN IF NOT EXISTS win_min int`);
  // 2026-07-27: 장중 V자 지표 (분봉은 당일만 조회 가능 → 저장 안 하면 소급 불가)
  await dbQuery(`ALTER TABLE shadow_1m_metrics
    ADD COLUMN IF NOT EXISTS drop_pct numeric, ADD COLUMN IF NOT EXISTS rebound_pct numeric,
    ADD COLUMN IF NOT EXISTS recover_pct numeric, ADD COLUMN IF NOT EXISTS low_pos numeric,
    ADD COLUMN IF NOT EXISTS base_hold int, ADD COLUMN IF NOT EXISTS lo_hhmm text`);
  await dbQuery(`CREATE TABLE IF NOT EXISTS shadow_1m_positions (
    id bigserial PRIMARY KEY, variant text NOT NULL, stock_code text NOT NULL,
    entry_d date NOT NULL, entry_px numeric NOT NULL, snapshot jsonb,
    status text NOT NULL DEFAULT 'open', exit_d date, exit_px numeric,
    exit_reason text, ret_pct numeric, hold_days int, at_hhmm text NOT NULL DEFAULT '',
    UNIQUE (variant, stock_code, entry_d, at_hhmm))`);
  // 실시간 청산 추적 상태 + 청산룰 변형 (watch-1m.mjs와 동일 마이그레이션 — 어느 쪽이 먼저 돌아도 되게)
  await dbQuery(`ALTER TABLE shadow_1m_positions
    ADD COLUMN IF NOT EXISTS run_hi numeric, ADD COLUMN IF NOT EXISTS tp1_done boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS tp2_done boolean DEFAULT false, ADD COLUMN IF NOT EXISTS realized numeric DEFAULT 0,
    ADD COLUMN IF NOT EXISTS qty_frac numeric DEFAULT 1,
    ADD COLUMN IF NOT EXISTS exit_rule text DEFAULT 'base', ADD COLUMN IF NOT EXISTS trail_pct numeric,
    ADD COLUMN IF NOT EXISTS hard_pct numeric, ADD COLUMN IF NOT EXISTS tp1_pct numeric,
    ADD COLUMN IF NOT EXISTS tp2_pct numeric, ADD COLUMN IF NOT EXISTS max_hold int`);
  await dbQuery(`ALTER TABLE shadow_1m_positions DROP CONSTRAINT IF EXISTS shadow_1m_positions_variant_stock_code_entry_d_at_hhmm_key`);
  await dbQuery(`CREATE UNIQUE INDEX IF NOT EXISTS shadow_1m_pos_uniq ON shadow_1m_positions (variant, stock_code, entry_d, at_hhmm, exit_rule)`);
  await dbQuery(`UPDATE shadow_1m_positions SET exit_rule=COALESCE(exit_rule,'base'), trail_pct=6, hard_pct=7, tp1_pct=6, tp2_pct=12, max_hold=10 WHERE trail_pct IS NULL`);
}

// ── 스냅샷: 전 종목 지표 적재 + 룰별 페이퍼 진입 ────────────────────────────────
async function snapshot() {
  const { scored, triggers, meta } = await scanNow({
    maxN: MAXN, paceMs: Number(argOf('--pace', 70)), log,
    windowMin: Number(argOf('--window', 0)),        // 0=당일 전 구간
    baseHHMM: argOf('--base', null),                 // 기준시각 고정(전 종목 동일 관측창)
    times: String(argOf('--times', '1000,1300,1520')).split(',').filter(Boolean), // 지표 적재 시각(단면 표본)
    trigger: !argv.includes('--no-trigger'),         // 페이퍼 진입 = 조건 최초 성립 분(라이브 진입시점 근사)
    triggerStep: Number(argOf('--tstep', 1)),
  });
  if (!scored.length) { log('채점 0종목 — 중단(장중 아님?)'); return; }
  const d = kstDate();

  for (let i = 0; i < scored.length; i += 200) {
    const vals = scored.slice(i, i + 200).map(s => `('${d}','${s.code}','${s.at}',${num(s.now)},${num(s.dayRet)},${num(s.vwapPrem)},${num(s.pos)},${s.higherLows},${num(s.vwapSlope)},${num(s.upBars)},${num(s.upVolFrac)},${num(s.pullback)},${num(s.atr1Pct)},${num(s.volPace)},${num(s.hiProx)},${num(s.rs20)},${s.selfUp},${num(s.score)},${num(s.scoreC)},${num(s.openGap)},${s.amBreak},${num(s.pullback60)},${num(s.vwapSlope60)},${s.bars},${meta.win},${num(s.dropPct)},${num(s.reboundPct)},${num(s.recoverPct)},${num(s.lowPos)},${s.baseHold},'${s.loHHMM}')`).join(',');
    await dbQuery(`INSERT INTO shadow_1m_metrics (d,stock_code,hhmm,px,day_ret,vwap_prem,pos,higher_lows,vwap_slope,up_bars,up_vol_frac,pullback,atr1,vol_pace,hi_prox,rs20,self_up,score_ab,score_c,open_gap,am_break,pullback60,vwap_slope60,bars,win_min,drop_pct,rebound_pct,recover_pct,low_pos,base_hold,lo_hhmm)
      VALUES ${vals} ON CONFLICT (d,stock_code,hhmm) DO NOTHING`);
  }
  log(`지표 적재 ${scored.length}행 (${d}, 시각 ${meta.times.join(',')})`);

  // 페이퍼 진입 = **조건 최초 성립 분** (라이브봇은 5초 스캔 후 즉시 매수 → 고정시각 샘플링보다 정합)
  //   종목 랭킹(TOPN)은 쓸 수 없다: 성립 시각이 종목마다 달라 한 시점에 줄세울 수 없기 때문.
  //   대신 성립한 전부를 점수와 함께 적재하고, 분석 단계에서 점수 분위로 걸러 본다.
  const byVariant = {};
  for (const g of (triggers ?? [])) {
    (byVariant[g.variant] ??= []).push(g);
    const s = g.s;
    const snap = JSON.stringify({ at: g.at, trigger: true, score: s.score, scoreC: s.scoreC, dayRet: s.dayRet, vwapPrem: s.vwapPrem, pos: s.pos, higherLows: s.higherLows, vwapSlope: s.vwapSlope, upVolFrac: s.upVolFrac, pullback: s.pullback, atr1: s.atr1Pct, volPace: s.volPace, hiProx: s.hiProx, rs20: s.rs20, selfUp: s.selfUp, openGap: s.openGap, amBreak: s.amBreak, mktRet20: meta.mktRet20 }).replace(/'/g, "''");
    for (const [rule, f] of Object.entries(EXITS)) {
      const e = f(s.atrPct ?? 4);
      await dbQuery(`INSERT INTO shadow_1m_positions (variant,stock_code,entry_d,entry_px,snapshot,at_hhmm,run_hi,exit_rule,trail_pct,hard_pct,tp1_pct,tp2_pct,max_hold)
        VALUES ('${g.variant}','${g.code}','${d}',${num(s.now)},'${snap}'::jsonb,'${g.at}',${num(s.now)},'${rule}',${num(e.trail)},${num(e.hard)},${num(e.tp1)},${num(e.tp2)},${e.maxHold}) ON CONFLICT DO NOTHING`);
    }
  }
  for (const [v, list] of Object.entries(byVariant)) {
    const med = [...list].sort((a, b) => a.at.localeCompare(b.at))[Math.floor(list.length / 2)]?.at;
    log(`  ${v}: 최초성립 ${list.length}종목 (중위 성립시각 ${med})`);
  }
  if (!Object.keys(byVariant).length) log('  최초성립 0건 — 페이퍼 진입 없음');
}

// ── 정산: 열린 포지션을 일봉으로 재생해 청산 판정 (멱등 — 매번 진입일부터 재계산) ──
async function settle() {
  const closedNow = []; await loadNames();
  const open = await dbQuery(`SELECT id,variant,stock_code,entry_d,entry_px,at_hhmm,
      COALESCE(exit_rule,'base') exit_rule, COALESCE(trail_pct,6) trail_pct, COALESCE(hard_pct,7) hard_pct,
      COALESCE(tp1_pct,6) tp1_pct, COALESCE(tp2_pct,12) tp2_pct, COALESCE(max_hold,10) max_hold
    FROM shadow_1m_positions WHERE status='open' ORDER BY entry_d`);
  if (!open.length) { log('열린 페이퍼 포지션 없음'); return; }
  const byCode = new Map();
  for (const p of open) { if (!byCode.has(p.stock_code)) byCode.set(p.stock_code, []); byCode.get(p.stock_code).push(p); }
  log(`정산 대상 ${open.length}건 / ${byCode.size}종목`);

  for (const [code, poss] of byCode) {
    let bars;
    try { bars = (await getDailyPrices(code)).slice().reverse(); }  // getDailyPrices는 최신순 → 과거순
    catch (e) { log(`  ${code} 일봉 조회 실패(보류): ${String(e.message).slice(0, 60)}`); continue; }
    for (const p of poss) {
      const ed = String(p.entry_d).slice(0, 10).replace(/-/g, '');
      const si = bars.findIndex(b => b.date > ed);          // 진입 **다음** 거래일부터 판정
      if (si < 0) continue;                                  // 아직 다음 거래일 없음
      const entry = Number(p.entry_px);
      // ★ 장중 레벨 판정(2026-07-27 수정): 진입은 분 단위인데 청산만 **종가**로 재면 비대칭이다.
      //   라이브봇은 30초 루프로 장중에 트레일·손절을 집행한다. 일봉 고가/저가로 그 접촉을 복원한다.
      //   트레일 기준선은 **전일까지의 고가**(runHi)로 잡는다 — 당일 고가로 선을 올리고 당일 저가로 판정하면 룩어헤드.
      const TRAIL = Number(p.trail_pct), HARD = Number(p.hard_pct), TP1 = Number(p.tp1_pct), TP2 = Number(p.tp2_pct), MAXHOLD = Number(p.max_hold);
      let runHi = entry, qty = 1, realized = 0, tp1 = false, tp2 = false, out = null;
      for (let i = si; i < bars.length && i - si < MAXHOLD; i++) {
        const hiD = Number(bars[i].high), loD = Number(bars[i].low), c = Number(bars[i].close), oD = Number(bars[i].open);
        const hardLv = entry * (1 - HARD / 100), trailLv = runHi * (1 - TRAIL / 100);
        const lv = Math.max(hardLv, trailLv);   // 하락 시 **먼저 닿는**(더 높은) 레벨이 실제 청산선
        if (loD <= lv) {
          const px = Math.min(lv, oD);          // 갭하락이면 시가 체결
          const r = (px / entry - 1) * 100;
          out = { reason: lv === hardLv ? 'hard_stop' : (tp1 ? 'trail_after_tp' : 'trailing'), px, ret: realized + qty * r, d: bars[i].date };
          break;
        }
        if (!tp1 && hiD >= entry * (1 + TP1 / 100)) { realized += 0.5 * TP1; qty -= 0.5; tp1 = true; }
        else if (tp1 && !tp2 && hiD >= entry * (1 + TP2 / 100)) { realized += 0.25 * TP2; qty -= 0.25; tp2 = true; }
        runHi = Math.max(runHi, hiD);
        if (i - si === MAXHOLD - 1) out = { reason: 'max_hold', px: c, ret: realized + qty * ((c / entry - 1) * 100), d: bars[i].date };
      }
      if (!out) continue;   // 아직 보유중
      out.ret -= COST;      // 비용 차감(총수익 → 순수익)
      const hold = bars.findIndex(b => b.date === out.d) - si + 1;
      await dbQuery(`UPDATE shadow_1m_positions SET status='closed', exit_d='${out.d.slice(0, 4)}-${out.d.slice(4, 6)}-${out.d.slice(6, 8)}', exit_px=${num(out.px)}, exit_reason='${out.reason}', ret_pct=${num(out.ret)}, hold_days=${hold} WHERE id=${p.id}`);
      log(`  청산 ${p.variant} ${code}: ${out.ret >= 0 ? '+' : ''}${out.ret.toFixed(2)}% (${out.reason}, ${hold}일)`);
      closedNow.push({ variant: `${p.variant}/${p.exit_rule}`, code, entry, exit: out.px, ret: out.ret, reason: out.reason, hold, entryD: String(p.entry_d).slice(0, 10), at: p.at_hhmm });
    }
  }
  if (!closedNow.length) { log('청산 발생 0건'); return; }

  // 손익 보고 — 청산이 생긴 날만 텔레그램 1통(건별 스팸 방지)
  const RSN = { hard_stop: '하드손절', trailing: '트레일', trail_after_tp: '익절후트레일', max_hold: '만기' };
  const lines = closedNow.sort((a, b) => b.ret - a.ret).map(c =>
    `${c.ret >= 0 ? '🔵' : '🔴'} ${c.variant} ${nm(c.code)} ${c.ret >= 0 ? '+' : ''}${c.ret.toFixed(2)}%  ${c.entry.toLocaleString()}→${c.exit.toLocaleString()} (${RSN[c.reason] ?? c.reason}, ${c.hold}일, ${c.entryD} ${c.at} 진입)`);
  const sum = closedNow.reduce((s, c) => s + c.ret, 0), win = closedNow.filter(c => c.ret > 0).length;
  const cum = await dbQuery(`SELECT variant, COUNT(*) n, ROUND(AVG(ret_pct),2) avg, ROUND(100.0*SUM(CASE WHEN ret_pct>0 THEN 1 ELSE 0 END)/COUNT(*),0) win
    FROM shadow_1m_positions WHERE status='closed' GROUP BY variant ORDER BY variant`);
  const msg = [
    `📊 섀도우 1분봉 청산 ${closedNow.length}건 (${kstDate()}) — 실주문 아님`,
    ...lines,
    `─ 오늘: 평균 ${(sum / closedNow.length >= 0 ? '+' : '') + (sum / closedNow.length).toFixed(2)}% · 승 ${win}/${closedNow.length}`,
    `─ 누적: ${cum.map(c => `${c.variant} ${c.n}건 ${Number(c.avg) >= 0 ? '+' : ''}${c.avg}% 승률 ${c.win}%`).join(' / ')}`,
    `⚠️ 거래일 20일 미만이면 방향 판단 금지(같은 날 표본은 상호 상관)`,
  ].join('\n');
  await tgSend(msg);
  log(`손익 보고 전송: ${closedNow.length}건 · 오늘 평균 ${(sum / closedNow.length).toFixed(2)}%`);
}

async function report() {
  const r = await dbQuery(`SELECT variant, COALESCE(exit_rule,'base') exit_rule, at_hhmm, COUNT(*) n, ROUND(AVG(ret_pct),2) avg_ret,
      ROUND(100.0*SUM(CASE WHEN ret_pct>0 THEN 1 ELSE 0 END)/COUNT(*),0) win, ROUND(AVG(hold_days),1) hold
    FROM shadow_1m_positions WHERE status='closed' GROUP BY variant, exit_rule, at_hhmm ORDER BY variant, exit_rule, at_hhmm`);
  const o = await dbQuery(`SELECT variant, COUNT(*) n FROM shadow_1m_positions WHERE status='open' GROUP BY variant ORDER BY variant`);
  const m = await dbQuery(`SELECT COUNT(*) rows, COUNT(DISTINCT d) days, COUNT(DISTINCT stock_code) codes FROM shadow_1m_metrics`);
  console.log(`\n=== 섀도우 누적 (실주문 없음) ===`);
  console.log(`지표 표본: ${m[0]?.rows ?? 0}행 / ${m[0]?.days ?? 0}일 / ${m[0]?.codes ?? 0}종목`);
  console.log(`열린 포지션: ${o.map(x => `${x.variant} ${x.n}`).join(' · ') || '없음'}`);

  // 보유중 평가손익 (현재가 = KIS 최근 종가. 종목 단위로 1콜)
  await loadNames();
  const oPos = await dbQuery(`SELECT variant,stock_code,entry_d,entry_px,at_hhmm FROM shadow_1m_positions WHERE status='open' ORDER BY entry_d,variant`);
  if (oPos.length) {
    const px = new Map();
    for (const code of new Set(oPos.map(p => p.stock_code))) {
      try { px.set(code, Number((await getDailyPrices(code))[0]?.close)); } catch {}
    }
    console.log('\n── 보유중 (평가손익, 비용 미차감) ──');
    console.log('룰             종목    진입일     진입시각  진입가      현재가      평가손익');
    for (const p of oPos) {
      const cur = px.get(p.stock_code), e = Number(p.entry_px);
      const ret = cur ? (cur / e - 1) * 100 : null;
      console.log(`${p.variant.padEnd(14)} ${nm(p.stock_code).padEnd(22)}  ${String(p.entry_d).slice(0, 10)}  ${(p.at_hhmm || '-').padStart(6)}  ${e.toLocaleString().padStart(10)}  ${(cur?.toLocaleString() ?? '?').padStart(10)}  ${ret == null ? '   ?' : ((ret >= 0 ? '+' : '') + ret.toFixed(2) + '%').padStart(8)}`);
    }
  }

  if (!r.length) { console.log('\n청산 완료 0건 — 성적 판정 불가'); return; }
  // 건별 청산 내역
  const tr = await dbQuery(`SELECT variant,stock_code,entry_d,at_hhmm,entry_px,exit_d,exit_px,exit_reason,ret_pct,hold_days
    FROM shadow_1m_positions WHERE status='closed' ORDER BY exit_d DESC, ret_pct DESC LIMIT 40`);
  const RSN = { hard_stop: '하드손절', trailing: '트레일', trail_after_tp: '익절후트레일', max_hold: '만기' };
  console.log('\n── 청산 내역 (최근 40건, 비용 0.33%p 차감 순수익) ──');
  console.log('룰             종목    진입→청산            진입가      청산가      손익      사유        보유');
  for (const t of tr) {
    const ret = Number(t.ret_pct);
    console.log(`${t.variant.padEnd(14)} ${nm(t.stock_code).padEnd(22)}  ${String(t.entry_d).slice(5, 10)} ${(t.at_hhmm || '').padStart(4)}→${String(t.exit_d).slice(5, 10)}  ${Number(t.entry_px).toLocaleString().padStart(10)}  ${Number(t.exit_px).toLocaleString().padStart(10)}  ${((ret >= 0 ? '+' : '') + ret.toFixed(2) + '%').padStart(8)}  ${(RSN[t.exit_reason] ?? t.exit_reason).padEnd(11)} ${t.hold_days}일`);
  }
  console.log('\n── 룰 × 진입시각 집계 ──');
  console.log('룰             청산룰  시각  청산  평균수익  승률  평균보유');
  for (const x of r) console.log(`${x.variant.padEnd(14)} ${String(x.exit_rule).padEnd(6)} ${x.at_hhmm} ${String(x.n).padStart(4)}  ${String(x.avg_ret).padStart(7)}%  ${String(x.win).padStart(3)}%  ${x.hold}일`);
  const days = await dbQuery(`SELECT COUNT(DISTINCT entry_d) d FROM shadow_1m_positions WHERE status='closed'`);
  console.log(`⚠️ 표본 ${r.reduce((s, x) => s + Number(x.n), 0)}건 / **진입일 ${days[0]?.d ?? 0}일** — 같은 날 표본은 상호 상관이라 건수가 아니라 **날짜 수**가 판정 기준이다(20일 미만 판단 금지)`);
}

await ensureTables();
if (argv.includes('--snapshot')) await snapshot();
else if (argv.includes('--settle')) await settle();
else if (argv.includes('--report')) await report();
else console.log('사용법: --snapshot | --settle | --report');
