/**
 * watch-1m.mjs — **라이브 1분 감시** (2026-07-27, 사용자 설계 그대로)
 *   거래량 상위 100 스크리닝 → 집중 10종목 선정 → 그 10종목만 1분마다 갱신 → 조건 최초 성립 시 페이퍼 진입.
 *
 * 왜 리플레이(shadow-1m)로 대체할 수 없나:
 *   ① 리플레이는 "그 분봉의 종가"로 진입한다 = 그 분이 끝나야 아는 값 → **미세 룩어헤드**. 라이브는 실시간 현재가로 진입.
 *   ② 체결 가정. 리플레이는 무조건 체결이지만 실제론 지정가·미체결·슬리피지가 있다.
 *   ③ 장중 상주 프로세스의 생존성·레이트리밋 내구성은 리플레이로 검증 불가.
 * 부수 효과(중요): 같은 룰의 `_live` 진입과 `shadow-1m`의 리플레이 진입을 나란히 쌓으면
 *   **"리플레이가 라이브를 얼마나 정확히 근사하나"** 를 직접 측정할 수 있다. 맞으면 앞으로 싼 방법을 신뢰해도 된다.
 *
 * 수집한 1분봉은 stock_prices_1m에 적재 → 15:20 마감 스냅샷은 이 종목들을 KIS 재조회 없이 재사용한다.
 * 실행: node watch-1m.mjs [--pool 100] [--focus 10] [--until 1520] [--rescreen 1300] [--pace 150]
 */
import 'dotenv/config';
import { loadDaily, score } from './scan-1m-core.mjs';
import { getMinuteBars } from './kis-api.js';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const POOL = Number(argOf('--pool', 100));
const FOCUS = Number(argOf('--focus', 10));
const UNTIL = String(argOf('--until', '1520'));
// 감시 개시 시각(2026-07-27 사용자 지시 "아침 8시부터"): 08:00에 기동해도 09:00 전엔 정규장 분봉이 0이라
//   판정 대상이 없다. 대신 **09:30에 첫 판정**을 하도록 대기한다 — 그 시점엔 봉이 30개(09:00~09:30)뿐이라
//   1콜/종목으로 전 종목을 훑을 수 있어 스크리닝이 85초에 끝난다(13콜 받을 때의 4분 → 1/3).
//   기존 09:35 기동은 스크리닝 4분 때문에 09:39부터 감시 = **오늘 실측 최초성립 중위 09:29를 놓쳤다.**
const START = String(argOf('--start', '0930'));
const RESCREEN = String(argOf('--rescreen', '1300'));
const PACE = Number(argOf('--pace', 150));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const kst = () => new Date(Date.now() + 9 * 3600_000);
const hhmm = () => { const d = kst(); return String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0'); };
const log = (m) => console.log(`[${kst().toISOString().slice(0, 19).replace('T', ' ')}] ${m}`);

// 2026-07-27 실측: 분당 쿼리가 많으면 Supabase 관리 API가 524(게이트웨이 타임아웃)를 던진다 → 5xx는 재시도
const dbQuery = async (sql, attempt = 0) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) {
    if (r.status >= 500 && attempt < 2) { await sleep(1500 * (attempt + 1)); return dbQuery(sql, attempt + 1); }
    throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
  }
  return r.json();
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(4) : 'NULL');
const today = () => kst().toISOString().slice(0, 10);
// 텔레그램 보고는 기본 OFF (2026-07-27 사용자 요청). 필요하면 --tg 로 켠다. 로그 파일엔 그대로 남는다.
const TG = argv.includes('--tg');
const tgSend = async (t) => {
  if (!TG) return;
  const T = process.env.TELEGRAM_BOT_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
  if (!T || !C) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: C, text: t }) });
    if (!r.ok) log(`텔레그램 실패 ${r.status}`);
  } catch (e) { log(`텔레그램 오류: ${String(e.message).slice(0, 50)}`); }
};

const COST = 0.33;
/**
 * 청산룰 변형 (2026-07-27 사용자 제안): 분봉 진입에 일봉 스윙 청산폭을 그대로 쓰는 게 맞는지 검증한다.
 *   같은 진입에 청산룰만 다르게 걸어 **진입 효과와 청산 효과를 분리**한다(진입가 동일 → 추가 비용 0).
 *   base = combo-v2 스윙 스케일(현행 라이브) / atr = 종목 일봉 ATR 비례 / tight = 분봉 진입에 맞춘 빠른 회수
 * 진입 시점에 **절대 %로 확정**해 행에 저장한다 → 청산 로직은 룰 분기 없이 균일하게 돈다.
 */
const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const EXITS = {
  base: () => ({ trail: 6, hard: 7, tp1: 6, tp2: 12, maxHold: 10 }),
  atr: (atrPct) => ({ trail: cl(1.5 * atrPct, 3, 12), hard: cl(2.0 * atrPct, 4, 14), tp1: cl(1.5 * atrPct, 3, 12), tp2: cl(3.0 * atrPct, 6, 24), maxHold: 10 }),
  tight: () => ({ trail: 3, hard: 4, tp1: 3, tp2: 6, maxHold: 5 }),
};

/** 누적 성적 한 줄 (텔레그램 꼬리에 붙임) */
async function cumLine() {
  try {
    const c = await dbQuery(`SELECT COUNT(*) n, ROUND(SUM(ret_pct),2) sum, ROUND(AVG(ret_pct),2) avg,
      ROUND(100.0*SUM(CASE WHEN ret_pct>0 THEN 1 ELSE 0 END)/GREATEST(COUNT(*),1),0) win,
      COUNT(DISTINCT entry_d) days FROM shadow_1m_positions WHERE status='closed'`);
    const o = await dbQuery(`SELECT COUNT(*) n FROM shadow_1m_positions WHERE status='open'`);
    const x = c[0] ?? {};
    if (!Number(x.n)) return `누적 청산 0건 · 보유 ${o[0]?.n ?? 0}건`;
    return `누적 ${x.n}건(진입일 ${x.days}일) 합계 ${Number(x.sum) >= 0 ? '+' : ''}${x.sum}%p · 평균 ${Number(x.avg) >= 0 ? '+' : ''}${x.avg}% · 승률 ${x.win}% · 보유 ${o[0]?.n ?? 0}건`;
  } catch { return '누적 조회 실패'; }
}

// 실시간 청산 추적용 상태 컬럼 (shadow-1m의 일봉 정산은 무상태 재계산이지만, 라이브는 고점·부분익절을 이어가야 한다)
await dbQuery(`ALTER TABLE shadow_1m_positions
  ADD COLUMN IF NOT EXISTS run_hi numeric, ADD COLUMN IF NOT EXISTS tp1_done boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS tp2_done boolean DEFAULT false, ADD COLUMN IF NOT EXISTS realized numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_frac numeric DEFAULT 1,
  ADD COLUMN IF NOT EXISTS exit_rule text DEFAULT 'base', ADD COLUMN IF NOT EXISTS trail_pct numeric,
  ADD COLUMN IF NOT EXISTS hard_pct numeric, ADD COLUMN IF NOT EXISTS tp1_pct numeric,
  ADD COLUMN IF NOT EXISTS tp2_pct numeric, ADD COLUMN IF NOT EXISTS max_hold int`);
// 청산룰이 행마다 다르므로 유니크 키에 포함 (이전 키는 exit_rule 없이 잡혀 있어 교체)
await dbQuery(`ALTER TABLE shadow_1m_positions DROP CONSTRAINT IF EXISTS shadow_1m_positions_variant_stock_code_entry_d_at_hhmm_key`);
await dbQuery(`CREATE UNIQUE INDEX IF NOT EXISTS shadow_1m_pos_uniq ON shadow_1m_positions (variant, stock_code, entry_d, at_hhmm, exit_rule)`);
// 기존 행(청산룰 도입 전) 파라미터 백필 = base
await dbQuery(`UPDATE shadow_1m_positions SET exit_rule=COALESCE(exit_rule,'base'), trail_pct=6, hard_pct=7, tp1_pct=6, tp2_pct=12, max_hold=10 WHERE trail_pct IS NULL`);

const { daily } = await loadDaily();
const MKT_RET20 = daily.get('005930').ret20;

// 종목명 맵 (DB에 &amp; 같은 HTML 엔티티가 섞여 있어 디코드 필요 — 예: "F&amp;F")
const NAME = new Map();
try {
  for (const r of await dbQuery('SELECT stock_code, corp_name FROM stocks')) {
    NAME.set(r.stock_code, String(r.corp_name ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  }
  log(`종목명 ${NAME.size}건 로드`);
} catch (e) { log(`종목명 로드 실패(코드로 표기): ${String(e.message).slice(0, 50)}`); }
const nm = (c) => (NAME.get(c) ? `${NAME.get(c)}(${c})` : c);
log(`유동성 통과 ${daily.size}종목 · 감시 종료 ${UNTIL} · 재스크리닝 ${RESCREEN}`);

/** 1단계: 전 종목 1콜로 거래량 페이스만 재서 상위 POOL 선별 (콜 1회/종목 = 싸다) */
async function screenPool() {
  const rows = [];
  for (const [code, d] of daily) {
    try {
      const a = await getMinuteBars(code, hhmm() + '00');
      const el = Math.max(1, (kst().getUTCHours() * 60 + kst().getUTCMinutes()) - 540);
      const pace = d.vol20 > 0 && a.acmlVol ? (a.acmlVol / (el / 390)) / d.vol20 : 0;
      if (a.now) rows.push({ code, pace, now: a.now, bars: a.bars, prevClose: a.prevClose ?? d.prevClose, acmlVol: a.acmlVol });
    } catch { /* 재시도는 kisGet 내부 */ }
    await sleep(PACE);
  }
  rows.sort((a, b) => b.pace - a.pace);
  log(`거래량 스크리닝: ${rows.length}종목 → 상위 ${POOL} (1위 ${rows[0]?.code} ${rows[0]?.pace.toFixed(2)}x)`);
  return rows.slice(0, POOL);
}

/** 2단계: POOL에 전 구간 분봉을 받아 채점 → 집중 FOCUS 선정 (게이트 통과 우선, 부족하면 점수순) */
async function pickFocus(pool) {
  const base = kst().getUTCHours() * 60 + kst().getUTCMinutes();
  const calls = Math.max(1, Math.ceil((base - 540) / 30));
  const hm = (t) => String(Math.floor(t / 60)).padStart(2, '0') + String(t % 60).padStart(2, '0');
  const out = [];
  for (const p of pool) {
    try {
      const seen = new Set(), bars = [];
      let now = 0, prevClose = null, acmlVol = null;
      for (let k = 0; k < calls; k++) {
        const a = await getMinuteBars(p.code, hm(base - 30 * k) + '00');
        await sleep(PACE);
        if (k === 0) { now = a.now; prevClose = a.prevClose; acmlVol = a.acmlVol; }
        for (const b of a.bars) if (!seen.has(b.hhmm)) { seen.add(b.hhmm); bars.push(b); }
        if (!a.bars.length) break;
      }
      bars.sort((x, y) => x.hhmm.localeCompare(y.hhmm));
      if (bars.length < 30 || !now) continue;
      const s = score({ code: p.code, now, prevClose: prevClose ?? p.prevClose, acmlVol, bars }, daily.get(p.code), { MKT_RET20, elapsed: base - 540 });
      out.push({ code: p.code, bars, s, gatesOk: !s.gatesC.length || !s.gates.length || !s.gatesA.length || !s.gatesV.length || !s.gatesV2.length || !s.gatesV3.length });
    } catch { /* skip */ }
  }
  // ★ 절반은 **이미 통과**(라이브 진입가 vs 리플레이 진입가 정합성 측정용),
  //   절반은 **1~2개만 미달인 근접 종목**(진짜 "최초 성립 시점"을 관측하려면 아직 안 된 놈을 봐야 한다).
  //   통과 종목만 담으면 전부 스크리닝 시각에 즉시 진입해서 시점 정보가 0이 된다(2026-07-27 실측으로 발견).
  const miss = (o) => Math.min(o.s.gates.length, o.s.gatesC.length, o.s.gatesA.length, o.s.gatesV.length, o.s.gatesV2.length);
  const byScore = (a, b) => (b.s.scoreC + b.s.score) - (a.s.scoreC + a.s.score);
  const passers = out.filter(o => o.gatesOk).sort(byScore);
  const near = out.filter(o => !o.gatesOk).sort((a, b) => (miss(a) - miss(b)) || byScore(a, b));
  const half = Math.ceil(FOCUS / 2);
  const focus = [...passers.slice(0, half), ...near.slice(0, FOCUS - Math.min(half, passers.length))];
  log(`집중 선정 ${focus.length}종목 (통과 ${Math.min(half, passers.length)} + 근접 ${focus.length - Math.min(half, passers.length)}): ${focus.map(f => `${nm(f.code)}[${f.gatesOk ? '통과' : `미달${miss(f)}`} ${f.s.scoreC.toFixed(0)}/${f.s.score.toFixed(0)}]`).join(' · ')}`);
  return focus;
}

const GATE = { A_hi120: 'gatesA', B_rs: 'gates', C_self: 'gatesC', D_nochase: 'gatesD', V_bounce: 'gatesV', V2_intra: 'gatesV2', V3_ubase: 'gatesV3' };
const entered = new Set();   // `${variant}:${code}` — 하루 1회
let watch = [];

async function recordEntry(variant, code, px, s, at) {
  const snap = JSON.stringify({ at, live: true, score: s.score, scoreC: s.scoreC, dayRet: s.dayRet, vwapPrem: s.vwapPrem, pos: s.pos, higherLows: s.higherLows, vwapSlope: s.vwapSlope, upVolFrac: s.upVolFrac, pullback: s.pullback, atr1: s.atr1Pct, volPace: s.volPace, hiProx: s.hiProx, rs20: s.rs20, selfUp: s.selfUp, openGap: s.openGap, amBreak: s.amBreak }).replace(/'/g, "''");
  // 청산룰 3종을 같은 진입가로 각각 적재 → 청산 효과만 분리 측정
  const atrPct = daily.get(code)?.atrPct ?? 4;
  for (const [rule, f] of Object.entries(EXITS)) {
    const e = f(atrPct);
    await dbQuery(`INSERT INTO shadow_1m_positions (variant,stock_code,entry_d,entry_px,snapshot,at_hhmm,run_hi,exit_rule,trail_pct,hard_pct,tp1_pct,tp2_pct,max_hold)
      VALUES ('${variant}_live','${code}','${today()}',${num(px)},'${snap}'::jsonb,'${at}',${num(px)},'${rule}',${num(e.trail)},${num(e.hard)},${num(e.tp1)},${num(e.tp2)},${e.maxHold}) ON CONFLICT DO NOTHING`);
  }
  log(`🟢 진입 ${variant}_live ${nm(code)} @${px.toLocaleString()} (${at})`);
  const why = variant === 'C_self'
    ? `저점상승 ${s.higherLows}/2 · VWAP기울기 ${s.vwapSlope >= 0 ? '+' : ''}${s.vwapSlope.toFixed(2)}% · 되돌림 ${s.pullback.toFixed(2)}%`
    : `전일비 ${s.dayRet >= 0 ? '+' : ''}${s.dayRet.toFixed(2)}% · VWAP프리 ${s.vwapPrem >= 0 ? '+' : ''}${s.vwapPrem.toFixed(2)}% · 거래량 ${s.volPace.toFixed(1)}x`;
  return `🟢 진입 ${variant} ${nm(code)} @${px.toLocaleString()} (${at.slice(0, 2)}:${at.slice(2, 4)})\n   ${why}`;
}

/** 보유 포지션 실시간 청산 감시 — 진입만 분 단위이고 청산이 종가면 비대칭이라 여기서도 분 단위로 본다 */
async function checkExits(priceOf) {
  const rows = await dbQuery(`SELECT id,variant,stock_code,entry_d,entry_px,at_hhmm,
      COALESCE(run_hi,entry_px) run_hi, COALESCE(tp1_done,false) tp1, COALESCE(tp2_done,false) tp2,
      COALESCE(realized,0) realized, COALESCE(qty_frac,1) qty,
      COALESCE(exit_rule,'base') exit_rule, COALESCE(trail_pct,6) trail_pct, COALESCE(hard_pct,7) hard_pct,
      COALESCE(tp1_pct,6) tp1_pct, COALESCE(tp2_pct,12) tp2_pct, COALESCE(max_hold,10) max_hold
    FROM shadow_1m_positions WHERE status='open'`);
  const msgs = [], upd = [];
  for (const p of rows) {
    let px = priceOf.get(p.stock_code);
    if (px == null) {
      try { px = (await getMinuteBars(p.stock_code, hhmm() + '00')).now; await sleep(PACE); } catch { continue; }
    }
    if (!px) continue;
    const entry = Number(p.entry_px);
    let runHi = Math.max(Number(p.run_hi), px), realized = Number(p.realized), qty = Number(p.qty);
    let tp1 = p.tp1, tp2 = p.tp2;
    const hold = Math.max(1, Math.round((new Date(today()) - new Date(String(p.entry_d).slice(0, 10))) / 86400000));
    // 청산폭은 행에 저장된 값(진입 시 확정) — 룰 분기 없이 균일하게 처리된다
    const TRAIL = Number(p.trail_pct), HARD = Number(p.hard_pct), TP1 = Number(p.tp1_pct), TP2 = Number(p.tp2_pct), MAXHOLD = Number(p.max_hold);
    const tag = `${p.variant}/${p.exit_rule}`;
    const hardLv = entry * (1 - HARD / 100), trailLv = runHi * (1 - TRAIL / 100);
    const lv = Math.max(hardLv, trailLv);
    let out = null;
    if (px <= lv) out = { reason: lv === hardLv ? 'hard_stop' : (tp1 ? 'trail_after_tp' : 'trailing'), px, ret: realized + qty * ((px / entry - 1) * 100) };
    else if (!tp1 && px >= entry * (1 + TP1 / 100)) { realized += 0.5 * TP1; qty -= 0.5; tp1 = true; msgs.push(`🔷 부분익절 ${tag} ${nm(p.stock_code)} +${TP1.toFixed(1)}% 도달 → 절반 익절 (잔량 ${(qty * 100).toFixed(0)}%)`); }
    else if (tp1 && !tp2 && px >= entry * (1 + TP2 / 100)) { realized += 0.25 * TP2; qty -= 0.25; tp2 = true; msgs.push(`🔷 부분익절2 ${tag} ${nm(p.stock_code)} +${TP2.toFixed(1)}% 도달 → 1/4 추가 익절 (잔량 ${(qty * 100).toFixed(0)}%)`); }
    else if (hold >= MAXHOLD) out = { reason: 'max_hold', px, ret: realized + qty * ((px / entry - 1) * 100) };

    if (out) {
      const ret = out.ret - COST;
      const RSN = { hard_stop: `하드손절 -${HARD}%`, trailing: `트레일 -${TRAIL}%`, trail_after_tp: `익절후 트레일 -${TRAIL}%`, max_hold: `만기 ${MAXHOLD}일` };
      await dbQuery(`UPDATE shadow_1m_positions SET status='closed', exit_d='${today()}', exit_px=${num(out.px)},
        exit_reason='${out.reason}', ret_pct=${num(ret)}, hold_days=${hold}, run_hi=${num(runHi)},
        tp1_done=${tp1}, tp2_done=${tp2}, realized=${num(realized)}, qty_frac=${num(qty)} WHERE id=${p.id}`);
      log(`${ret >= 0 ? '🔵' : '🔴'} 청산 ${tag} ${nm(p.stock_code)} ${ret.toFixed(2)}% (${out.reason})`);
      msgs.push(`${ret >= 0 ? '🔵' : '🔴'} 청산 ${tag} ${nm(p.stock_code)} ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}% (${RSN[out.reason]}, ${hold}일)\n   ${entry.toLocaleString()} → ${out.px.toLocaleString()}`);
    } else if (runHi > Number(p.run_hi) || tp1 !== p.tp1 || tp2 !== p.tp2) {
      // 변경분만 모아 **분당 1쿼리**로 일괄 반영 (포지션마다 쏘면 분당 20건 → 524 발생. 2026-07-27 실측)
      upd.push(`(${p.id},${num(runHi)},${tp1},${tp2},${num(realized)},${num(qty)})`);
    }
  }
  if (upd.length) {
    await dbQuery(`UPDATE shadow_1m_positions p SET run_hi=v.run_hi, tp1_done=v.tp1, tp2_done=v.tp2, realized=v.realized, qty_frac=v.qty
      FROM (VALUES ${upd.join(',')}) AS v(id, run_hi, tp1, tp2, realized, qty) WHERE p.id = v.id::bigint`);
  }
  return msgs;
}

async function saveBars(code, bars) {
  const d = today();
  const rows = bars.filter(b => b.hhmm && b.v >= 0).map(b => `('${code}','${d} ${b.hhmm.slice(0, 2)}:${b.hhmm.slice(2, 4)}:00+09',${b.o},${b.h},${b.l},${b.c},${b.v})`);
  for (let i = 0; i < rows.length; i += 300) {
    await dbQuery(`INSERT INTO stock_prices_1m (stock_code,ts,open,high,low,close,volume)
      VALUES ${rows.slice(i, i + 300).join(',')} ON CONFLICT (stock_code, ts) DO NOTHING`);
  }
}

// ── 메인: 스크리닝 → 1분 루프 ───────────────────────────────────────────────
// 재기동 대비: 오늘 이미 기록한 라이브 진입을 불러와 중복 진입을 막는다
try {
  const prev = await dbQuery(`SELECT variant, stock_code FROM shadow_1m_positions WHERE entry_d='${today()}' AND variant LIKE '%\\_live'`);
  for (const r of prev) entered.add(`${String(r.variant).replace('_live', '')}:${r.stock_code}`);
  if (prev.length) log(`오늘 기존 라이브 진입 ${prev.length}건 로드(중복 방지)`);
} catch (e) { log(`기존 진입 로드 실패(계속): ${String(e.message).slice(0, 60)}`); }

// 개시 시각까지 대기 (08:00 기동 → 09:30 첫 판정). 준비작업(일봉 캐시·종목명)은 끝낸 상태로 대기한다.
while (hhmm() < START) {
  const left = (Number(START.slice(0, 2)) * 60 + Number(START.slice(2, 4))) - (kst().getUTCHours() * 60 + kst().getUTCMinutes());
  if (left % 15 === 0 || left <= 2) log(`개시 대기: ${START}까지 ${left}분 (준비 완료 — 유동성 ${daily.size}종목·종목명 ${NAME.size}건)`);
  await sleep(60_000);
}
watch = await pickFocus(await screenPool());
let rescreened = hhmm() >= RESCREEN;
let ticks = 0, errs = 0;

while (hhmm() < UNTIL) {
  const t0 = Date.now();
  const at = hhmm();
  const events = [], priceOf = new Map();
  for (const w of watch) {
    try {
      const a = await getMinuteBars(w.code, at + '00');
      await sleep(PACE);
      const seen = new Set(w.bars.map(b => b.hhmm));
      for (const b of a.bars) if (!seen.has(b.hhmm)) w.bars.push(b);
      w.bars.sort((x, y) => x.hhmm.localeCompare(y.hhmm));
      // 게이트는 **직전까지 완성된 봉**으로 평가하고, 진입가는 **실시간 현재가**로 쓴다 → 룩어헤드 0
      const el = Math.max(1, Number(at.slice(0, 2)) * 60 + Number(at.slice(2, 4)) - 540);
      const s = score({ code: w.code, now: a.now, prevClose: w.s.prevClose ?? a.prevClose, acmlVol: a.acmlVol, bars: w.bars }, daily.get(w.code), { MKT_RET20, elapsed: el });
      w.s = s;
      priceOf.set(w.code, a.now);
      for (const [variant, key] of Object.entries(GATE)) {
        const k = `${variant}:${w.code}`;
        if (entered.has(k) || s[key].length) continue;
        entered.add(k);
        events.push(await recordEntry(variant, w.code, a.now, s, at));
      }
    } catch (e) { errs++; if (errs % 20 === 1) log(`조회 오류(${errs}회): ${String(e.message).slice(0, 60)}`); }
  }
  // 보유분 실시간 청산 감시 → 진입·청산 이벤트를 분당 1통으로 묶어 전송(건별 스팸 방지)
  try { events.push(...await checkExits(priceOf)); }
  catch (e) { log(`청산감시 오류: ${String(e.message).slice(0, 60)}`); }
  if (events.length) await tgSend([`📊 섀도우 시뮬레이션 (실주문 아님) ${at.slice(0, 2)}:${at.slice(2, 4)}`, ...events, `─ ${await cumLine()}`].join('\n'));
  if (!rescreened && hhmm() >= RESCREEN) {
    rescreened = true;
    log('재스크리닝 시작');
    for (const w of watch) await saveBars(w.code, w.bars);   // 교체 전 저장
    watch = await pickFocus(await screenPool());
  }
  if (++ticks % 30 === 0) log(`감시 ${ticks}분 경과 · 진입 ${entered.size}건 · 오류 ${errs}회 · 대상 ${watch.map(w => w.code).join(',')}`);
  const wait = 60_000 - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
}

for (const w of watch) await saveBars(w.code, w.bars);
log(`감시 종료(${UNTIL}) · 총 ${ticks}분 · 진입 ${entered.size}건 · 오류 ${errs}회 · 1분봉 적재 ${watch.length}종목`);
