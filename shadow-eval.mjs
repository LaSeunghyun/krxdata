/**
 * shadow-eval.mjs — 거래 **1건마다** 사후 평가 (2026-07-27, 사용자 프레임 전환)
 *
 * 프레임: "판정"과 "평가"를 분리한다.
 *   - 판정(verdict): 룰을 채택할지 = 통계. 진입일 20일+ 필요. 느리다.
 *   - 평가(evaluation): 이 거래에서 **언제 팔았으면/샀으면** 나았나 = 사후 최적해와의 갭. 거래마다 즉시.
 *   손실 자체는 문제가 아니다. 손실의 **원인이 어디인지**(선정/진입/청산)를 매번 분류해 룰을 고치는 게 목적이다.
 *
 * 산출: shadow_1m_eval 1행/거래
 *   upside      = 보유기간 최고가로 팔았을 때 수익 (사후 최적 청산)
 *   missed      = upside - 실제손익  → **청산이 얼마를 놓쳤나**
 *   betterEntry = 진입 후 더 좋았던 진입가(1분봉 있으면 정확) → **진입이 얼마나 비쌌나**
 *   diagnosis   = 선정오류 / 청산과다 / 익절보수 / 추격진입 / 정상
 *
 * 실행: node shadow-eval.mjs --run     (미평가 청산건 전부 평가)
 *       node shadow-eval.mjs --report  (진단 집계 + 다음에 고칠 지점)
 */
import 'dotenv/config';
import { getDailyPrices, getMinuteBars } from './kis-api.js';

const argv = process.argv.slice(2);
const COST = 0.33;
const log = (m) => console.log(`[${new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')}] ${m}`);
const dbQuery = async (sql, attempt = 0) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) {
    if (r.status >= 500 && attempt < 2) { await new Promise(s => setTimeout(s, 1500 * (attempt + 1))); return dbQuery(sql, attempt + 1); }
    throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
  }
  return r.json();
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(4) : 'NULL');
const q1 = (s) => String(s ?? '').replace(/'/g, "''");
const kstDate = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

const NAME = new Map();
async function loadNames() {
  if (NAME.size) return;
  try { for (const r of await dbQuery('SELECT stock_code, corp_name FROM stocks')) NAME.set(r.stock_code, String(r.corp_name ?? '').replace(/&amp;/g, '&')); } catch {}
}
const nm = (c) => (NAME.get(c) ? `${NAME.get(c)}(${c})` : c);

async function ensureTable() {
  await dbQuery(`CREATE TABLE IF NOT EXISTS shadow_1m_eval (
    pos_id bigint PRIMARY KEY, variant text, exit_rule text, stock_code text,
    entry_d date, exit_d date, at_hhmm text, hold_days int,
    entry_px numeric, exit_px numeric, actual_ret numeric, exit_reason text,
    best_high numeric, best_high_d date, upside_pct numeric,
    worst_low numeric, drawdown_pct numeric, optimal_ret numeric, missed_pct numeric,
    entry_day_ret numeric, better_entry_px numeric, better_entry_gain numeric, entry_precision text,
    diagnosis text, note text, evaluated_at timestamptz DEFAULT now())`);
  await dbQuery(`ALTER TABLE shadow_1m_eval ADD COLUMN IF NOT EXISTS hold_ret numeric,
    ADD COLUMN IF NOT EXISTS exit_alpha numeric, ADD COLUMN IF NOT EXISTS rr numeric`);
}

/**
 * 진입일의 **진입 시각 이후** 고가·저가.
 * ★ 이게 정확해야 한다: 일봉 고가를 쓰면 **진입 전에 찍힌 고가**가 섞여 "놓친 이익"이 부풀려진다.
 *   (2026-07-27 실측: 진입시 당일상승 평균 +18%인 추격 진입들이라 일봉 고가는 대개 진입 전 값이었다)
 *   KIS 분봉은 당일만 조회 가능 → 당일 청산건만 정확(1m), 과거일은 일봉 폴백(상한으로 표기).
 */
async function postEntryPath(code, entryD, atHHMM, entryDayBar) {
  if (entryD === kstDate() && atHHMM) {
    try {
      const k = new Date(Date.now() + 9 * 3600_000);
      const nowMin = k.getUTCHours() * 60 + k.getUTCMinutes();
      const seen = new Set(), bars = [];
      for (let t = nowMin; t >= 540; t -= 30) {
        const hm = String(Math.floor(t / 60)).padStart(2, '0') + String(t % 60).padStart(2, '0');
        const a = await getMinuteBars(code, hm + '00');
        if (!a.bars.length) break;
        for (const b of a.bars) if (!seen.has(b.hhmm)) { seen.add(b.hhmm); bars.push(b); }
        await new Promise(s => setTimeout(s, 120));
      }
      const after = bars.filter(b => b.hhmm >= atHHMM);
      if (after.length) return { hi: Math.max(...after.map(b => b.h)), lo: Math.min(...after.map(b => b.l)), precision: '1m' };
    } catch { /* 폴백 */ }
  }
  return {
    hi: entryDayBar ? Number(entryDayBar.high) : null,
    lo: entryDayBar ? Number(entryDayBar.low) : null,
    precision: 'daily(상한)',
  };
}

async function run() {
  await loadNames(); await ensureTable();
  const rows = await dbQuery(`SELECT p.id, p.variant, COALESCE(p.exit_rule,'base') exit_rule, p.stock_code, p.entry_d, p.exit_d,
      p.at_hhmm, p.entry_px, p.exit_px, p.ret_pct, p.exit_reason, p.hold_days, p.snapshot
    FROM shadow_1m_positions p LEFT JOIN shadow_1m_eval e ON e.pos_id = p.id
    WHERE p.status='closed' AND e.pos_id IS NULL ORDER BY p.exit_d, p.id`);
  if (!rows.length) { log('미평가 청산건 없음'); return; }
  log(`평가 대상 ${rows.length}건`);

  const barCache = new Map();
  for (const p of rows) {
    let bars = barCache.get(p.stock_code);
    if (!bars) {
      try { bars = (await getDailyPrices(p.stock_code)).slice().reverse(); barCache.set(p.stock_code, bars); }
      catch (e) { log(`  ${p.stock_code} 일봉 실패(보류): ${String(e.message).slice(0, 50)}`); continue; }
    }
    const ed = String(p.entry_d).slice(0, 10).replace(/-/g, '');
    const xd = String(p.exit_d).slice(0, 10).replace(/-/g, '');
    const hold = bars.filter(b => b.date >= ed && b.date <= xd);
    const entry = Number(p.entry_px), actual = Number(p.ret_pct);
    const snap = typeof p.snapshot === 'string' ? (() => { try { return JSON.parse(p.snapshot); } catch { return {}; } })() : (p.snapshot ?? {});

    // 보유기간 최고/최저 — **진입일은 진입 이후 구간만** 사용(진입 전 고가 오염 제거), 이후 날짜는 일봉 전체
    const entryDayBar = hold.find(b => b.date === ed);
    const path = await postEntryPath(p.stock_code, String(p.entry_d).slice(0, 10), p.at_hhmm, entryDayBar);
    const later = hold.filter(b => b.date > ed);
    const hi = Math.max(entry, path.hi ?? entry, ...later.map(b => Number(b.high)));
    const lo = Math.min(entry, path.lo ?? entry, ...later.map(b => Number(b.low)));
    const hiD = later.find(b => Number(b.high) === hi)?.date ?? ed;
    const upside = (hi / entry - 1) * 100;
    const drawdown = (lo / entry - 1) * 100;
    const optimal = upside - COST;
    const missed = optimal - actual;
    const be = { px: lo, precision: path.precision };          // 진입 이후 최저가 = 더 좋았던 진입가
    const beGain = (entry / be.px - 1) * 100;   // 그 가격에 샀으면 얻었을 추가 이익(%p)
    const entryDayRet = Number(snap.dayRet ?? 0);

    // ★ 현실적 비교군 = "안 팔고 버텼으면"(만기 지평 종가). 최고가 청산은 달성 불가능한 상한이라 진단 기준으로 쓰면
    //   트레일이 폭락을 막아준 거래까지 "청산과다"로 오분류한다(2026-07-27 위닉스 케이스에서 실제로 발생).
    const horizonEnd = bars.filter(b => b.date >= ed).slice(0, Math.max(1, Number(p.hold_days) || 1) + 1).at(-1);
    const holdRet = horizonEnd ? (Number(horizonEnd.close) / entry - 1) * 100 - COST : actual;
    const exitAlpha = actual - holdRet;             // 청산룰이 버티기 대비 벌어준 값(+면 청산이 이득)
    const rr = Math.abs(drawdown) > 0.01 ? upside / Math.abs(drawdown) : (upside > 0 ? 99 : 0); // 여력/위험

    // ── 진단: 손실 원인을 선정 / 진입 / 청산 중 어디로 볼지 ──
    let dg, note;
    if (upside < 2) {
      dg = '선정오류'; note = `진입 후 최대 +${upside.toFixed(2)}%밖에 못 감 — 신호 자체가 틀렸다`;
    } else if (rr < 1) {
      dg = '선정오류'; note = `여력 +${upside.toFixed(2)}% vs 위험 ${drawdown.toFixed(2)}% (RR ${rr.toFixed(2)}) — 비대칭이 불리한 신호. 청산 탓 아님`;
    } else if (exitAlpha < -2) {
      dg = '청산과다'; note = `버티기 ${holdRet.toFixed(2)}%보다 ${(-exitAlpha).toFixed(2)}%p 나쁨 — 청산폭이 변동성에 안 맞다`;
    } else if (actual >= 0 && missed >= 5) {
      dg = '익절보수'; note = `+${actual.toFixed(2)}% 먹었지만 최적 +${optimal.toFixed(2)}% — ${missed.toFixed(2)}%p 놓침`;
    } else if (entryDayRet >= 8 && actual < 0) {
      dg = '추격진입'; note = `당일 +${entryDayRet.toFixed(1)}% 오른 뒤 진입 → 되돌림 부담. 청산 기여 ${exitAlpha >= 0 ? '+' : ''}${exitAlpha.toFixed(2)}%p`;
    } else if (actual >= 0) {
      dg = '정상'; note = `+${actual.toFixed(2)}% (버티기 ${holdRet.toFixed(2)}%, 청산 기여 ${exitAlpha >= 0 ? '+' : ''}${exitAlpha.toFixed(2)}%p)`;
    } else {
      dg = '청산성공'; note = `${actual.toFixed(2)}%로 막음 — 버티기 ${holdRet.toFixed(2)}%였다(청산 기여 +${exitAlpha.toFixed(2)}%p)`;
    }

    await dbQuery(`INSERT INTO shadow_1m_eval (pos_id,variant,exit_rule,stock_code,entry_d,exit_d,at_hhmm,hold_days,
        entry_px,exit_px,actual_ret,exit_reason,best_high,best_high_d,upside_pct,worst_low,drawdown_pct,optimal_ret,missed_pct,
        entry_day_ret,better_entry_px,better_entry_gain,entry_precision,diagnosis,note,hold_ret,exit_alpha,rr)
      VALUES (${p.id},'${q1(p.variant)}','${q1(p.exit_rule)}','${p.stock_code}','${String(p.entry_d).slice(0, 10)}','${String(p.exit_d).slice(0, 10)}',
        '${q1(p.at_hhmm)}',${Number(p.hold_days) || 1},${num(entry)},${num(p.exit_px)},${num(actual)},'${q1(p.exit_reason)}',
        ${num(hi)},'${hiD.slice(0, 4)}-${hiD.slice(4, 6)}-${hiD.slice(6, 8)}',${num(upside)},${num(lo)},${num(drawdown)},${num(optimal)},${num(missed)},
        ${num(entryDayRet)},${num(be.px)},${num(beGain)},'${be.precision}','${dg}','${q1(note)}',${num(holdRet)},${num(exitAlpha)},${num(rr)})
      ON CONFLICT (pos_id) DO NOTHING`);
    log(`  ${dg.padEnd(6)} ${p.variant}/${p.exit_rule} ${nm(p.stock_code)} 실제 ${actual >= 0 ? '+' : ''}${actual.toFixed(2)}% / 최적 +${optimal.toFixed(2)}% / 놓침 ${missed.toFixed(2)}%p`);
  }
}

async function report() {
  await loadNames();
  const dg = await dbQuery(`SELECT diagnosis, COUNT(*) n, ROUND(AVG(actual_ret),2) act, ROUND(AVG(upside_pct),2) up,
      ROUND(AVG(drawdown_pct),2) dd, ROUND(AVG(rr),2) rr, ROUND(AVG(hold_ret),2) hold, ROUND(AVG(exit_alpha),2) alpha,
      ROUND(AVG(missed_pct),2) missed, ROUND(AVG(entry_day_ret),1) edr
    FROM shadow_1m_eval GROUP BY diagnosis ORDER BY n DESC`);
  if (!dg.length) { console.log('평가 0건'); return; }
  console.log('\n=== 거래별 평가 집계 (판정 아님 — 원인 분류) ===');
  console.log('진단      건수  실제평균  버티기   청산기여  여력    위험    RR    진입시당일상승');
  for (const r of dg) console.log(`${r.diagnosis.padEnd(8)} ${String(r.n).padStart(4)}  ${String(r.act).padStart(7)}%  ${String(r.hold).padStart(6)}%  ${String(r.alpha).padStart(7)}%p  ${String(r.up).padStart(6)}%  ${String(r.dd).padStart(6)}%  ${String(r.rr).padStart(4)}  ${String(r.edr).padStart(11)}%`);

  const byRule = await dbQuery(`SELECT exit_rule, COUNT(*) n, ROUND(AVG(actual_ret),2) act, ROUND(AVG(hold_ret),2) hold, ROUND(AVG(exit_alpha),2) alpha,
      ROUND(100.0*SUM(CASE WHEN actual_ret>0 THEN 1 ELSE 0 END)/COUNT(*),0) win FROM shadow_1m_eval GROUP BY exit_rule ORDER BY act DESC`);
  console.log('\n── 청산룰별 (같은 진입에 룰만 다름 → 청산 효과만 분리) ──');
  console.log('청산룰  건수  실제평균  버티기   청산기여  승률');
  for (const r of byRule) console.log(`${r.exit_rule.padEnd(7)} ${String(r.n).padStart(4)}  ${String(r.act).padStart(7)}%  ${String(r.hold).padStart(6)}%  ${String(r.alpha).padStart(7)}%p  ${String(r.win).padStart(3)}%`);

  const worst = await dbQuery(`SELECT variant,exit_rule,stock_code,entry_d,at_hhmm,actual_ret,upside_pct,missed_pct,diagnosis,note
    FROM shadow_1m_eval ORDER BY missed_pct DESC LIMIT 5`);
  console.log('\n── 가장 많이 놓친 거래 5건 (여기가 고칠 지점) ──');
  for (const r of worst) console.log(`  ${nm(r.stock_code)} ${r.variant}/${r.exit_rule} ${String(r.entry_d).slice(5, 10)} ${r.at_hhmm}\n     ${r.diagnosis}: ${r.note}`);

  // 다음에 고칠 지점 = 가장 많은 진단 유형
  const top = dg[0];
  const fix = {
    선정오류: '진입 조건(게이트)을 고쳐야 한다. 청산 파라미터를 만지면 헛수고다.',
    청산과다: '청산폭이 종목 변동성에 안 맞다 → atr/tight 중 청산기여가 높은 쪽으로 base 교체 검토.',
    청산성공: '청산룰이 폭락을 막고 있다. 문제는 신호 쪽 — 선정 기준을 보라.',
    익절보수: '익절이 너무 이르다 → tp1 상향 또는 부분익절 비율 축소를 후보로.',
    추격진입: '진입 시 당일 상승률 상한(예: dayRet ≤ 8%)을 게이트에 추가 검토.',
    정상: '현재 룰이 의도대로 작동 중. 표본을 더 쌓아라.',
    허용손실: '상승여력 자체가 작은 신호가 많다 → 선정 기준 강화 후보.',
  }[top.diagnosis] ?? '분류 확인 필요';
  console.log(`\n▶ 최다 진단 "${top.diagnosis}"(${top.n}건) → ${fix}`);
  console.log('⚠️ 이건 원인 분류다. 룰 채택 판정은 여전히 진입일 20일+ 필요.');
}

if (argv.includes('--run')) await run();
else if (argv.includes('--report')) await report();
else { await run(); await report(); }
