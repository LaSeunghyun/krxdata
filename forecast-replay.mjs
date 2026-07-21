#!/usr/bin/env node
/**
 * forecast-replay.mjs — 과거 날짜의 아침(pre)·저녁(close) 보고를 look-ahead 없이 재현
 *   실행: node forecast-replay.mjs 20260720 [--send]
 *   원장 미기록. 각 시점에 "그때 알 수 있었던 데이터"만 사용:
 *     아침: 일봉 < D, 수급 확정분 < D, 공시 < D
 *     저녁: 일봉 ≤ D(당일 종가 포함), 수급 확정분 < D(당일 미확정), 공시 ≤ D, 아침 예측 채점
 *   뉴스 웹검색은 과거 시점 재현이 불가능하므로 비활성(보고서에 미제공 명시).
 */
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { getDailyCandles } from './toss-api.js';
import { fetch1mByDate } from './forecast-intraday.mjs';
import { buildForecast, scoreVerification, sampleStats, ENGINE_VERSION } from './forecast-core.mjs';
import { composeReport } from './forecast-llm.mjs';
import { getInvestorDaily, isKisConfigured } from './kis-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env') });

const D = process.argv[2];
const SEND = process.argv.includes('--send');
if (!/^\d{8}$/.test(D ?? '')) { console.error('사용법: node forecast-replay.mjs YYYYMMDD [--send]'); process.exit(1); }

async function dbQuery(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_MANAGEMENT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(j?.message ?? 'DB 오류');
  return j;
}
async function sendTg(text) {
  if (!SEND) return;
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: text.slice(0, 4000) }),
  });
}

const MARKETS = [
  { key: '코스피', code: '069500' },
  { key: '코스닥', code: '229200' },
];
const dash = (k) => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
const lbl = (k) => `${k.slice(4, 6)}/${k.slice(6, 8)}`;
const toReturns = (cs) => cs.slice(1).map((c, i) => (c / cs[i] - 1) * 100);

// 전일 등락 유사일의 익일 수익률 (조건부 표본)
function condNextDay(series) {
  const rets = series.slice(1).map((x, i) => ({ date: x.date, ret: (x.close / series[i].close - 1) * 100 }));
  if (rets.length < 3) return { xs: [], yRet: null, tol: null };
  const yRet = rets[rets.length - 1].ret;
  const tol = Math.max(1.5, Math.abs(yRet) * 0.5);
  const xs = [];
  for (let i = 1; i < rets.length; i++) {
    if (Math.abs(rets[i - 1].ret - yRet) <= tol) xs.push(rets[i].ret);
  }
  return { xs, yRet: +yRet.toFixed(2), tol: +tol.toFixed(2) };
}

async function main() {
  // 데이터 준비 (전 기간 → 시점별로 잘라 쓴다)
  const daily = {}, m1 = {};
  for (const m of MARKETS) {
    daily[m.key] = (await getDailyCandles(m.code, 300)).reverse()
      .map(c => ({ date: String(c.timestamp).slice(0, 10).replace(/-/g, ''), close: c.close }))
      .filter(x => x.close > 0);
    m1[m.key] = await fetch1mByDate(m.code, 12000);
  }
  const flows = {};
  if (isKisConfigured()) {
    const top = await dbQuery(`SELECT stock_code FROM stock_analysis ORDER BY market_cap_tril DESC NULLS LAST LIMIT 5`);
    for (const t of top) {
      for (const r of await getInvestorDaily(t.stock_code).catch(() => [])) {
        (flows[r.date] ??= { frgn: 0, orgn: 0, n: 0 });
        flows[r.date].frgn += Math.round(r.frgn_amt_mil / 100);
        flows[r.date].orgn += Math.round(r.orgn_amt_mil / 100);
        flows[r.date].n += 1;
      }
    }
  }
  const lastFlowBefore = (k) => {
    const ds = Object.keys(flows).filter(d => d < k).sort();
    return ds.length ? { date: ds[ds.length - 1], ...flows[ds[ds.length - 1]] } : null;
  };
  const discBefore = async (k, inclusive) => dbQuery(`
    SELECT sd.rcept_dt, sa.corp_name, sa.sector, sd.report_nm, sa.market_cap_tril
    FROM stock_disclosures sd JOIN stock_analysis sa ON sa.stock_code = sd.stock_code
    WHERE sd.rcept_dt ${inclusive ? '<=' : '<'} '${dash(k)}' AND sd.rcept_dt >= '${dash(k)}'::date - 3
    ORDER BY CASE WHEN sd.report_nm ~ '(공급계약|수주|유상증자|합병|실적|잠정|배당|임상)' THEN 0 ELSE 1 END,
             sa.market_cap_tril DESC NULLS LAST LIMIT 10`);

  const engineFor = (key, series) => {
    const rs = toReturns(series.map(x => x.close));
    const cond = condNextDay(series);
    const f = buildForecast(rs, { condReturns: cond.xs });
    return f ? {
      name: key, f,
      general_stats: sampleStats(rs.slice(-120)), cond_stats: sampleStats(cond.xs),
      cond_desc: { prev_day_ret: cond.yRet, tolerance_pp: cond.tol, blend_weight: +(cond.xs.length / (cond.xs.length + 8)).toFixed(2) },
    } : null;
  };
  const engineRow = (e) => ({
    name: e.name, median_pct: e.f.median, low_pct: e.f.low, high_pct: e.f.high,
    prob_up: e.f.probs.up, prob_flat: e.f.probs.flat, prob_down: e.f.probs.down,
    confidence: e.f.confidence, flat_band_pct: e.f.band, sigma_pct: e.f.sigma,
    general_stats: e.general_stats, cond_stats: e.cond_stats, cond_desc: e.cond_desc,
  });

  // ── 아침(08:35) 재현: 일봉 < D, 목표 = 직전거래일 종가 → D 종가 ──
  const morning = {};
  for (const m of MARKETS) {
    const past = daily[m.key].filter(x => x.date < D);
    morning[m.key] = { series: past, engine: engineFor(m.key, past) };
  }
  const preStart = morning['코스피'].series.at(-1).date;
  const prePayload = {
    replay_note: `과거 재현: ${lbl(D)} 08:35 시점에 알 수 있던 데이터만 사용. 뉴스 웹검색 미제공(재현 불가) — 보고서에 명시할 것.`,
    now_kst: `${D} 08:35`, phase: 'pre', allow_websearch: false,
    span: { start: `${lbl(preStart)} 종가`, end: `${lbl(D)} 종가` },
    data_state: {
      price_asof: preStart, quality: 'A', notes: ['과거 재현 실행'],
      flow_basis: lastFlowBefore(D) ? `확정 최신 ${lastFlowBefore(D).date} · 제한된 대형주 바스켓` : '미제공',
      disclosure_latest: '전일까지', news: '미제공(과거 재현)',
    },
    engine: MARKETS.map(m => engineRow(morning[m.key].engine)),
    price_structure: MARKETS.map(m => ({
      name: m.key,
      prev_day_ret_pct: +((morning[m.key].series.at(-1).close / morning[m.key].series.at(-2).close - 1) * 100).toFixed(2),
      note: '장전 — 당일 분봉 없음',
    })),
    investor_flow: lastFlowBefore(D) ? { ...lastFlowBefore(D), label: `제한된 대형주 바스켓 참고지표(${lastFlowBefore(D).n}종목, 확정 ${lastFlowBefore(D).date})` } : null,
    disclosures: { recent: await discBefore(D, false), stale: false },
    verification: [], rolling_buckets: { note: '재현 실행 — 누적 통계 없음' },
  };
  const pre = composeReport(prePayload);
  const preText = `⏪ 과거 재현 (${lbl(D)} 아침 08:35 시점, 엔진 ${ENGINE_VERSION} · 원장 미기록)\n\n${pre.text ?? `합성 실패: ${pre.error}`}`;
  console.log(preText); console.log('\n================\n');
  await sendTg(preText);

  // ── 저녁(16:10) 재현: 일봉 ≤ D, 아침 예측 채점 + 익일 예측 ──
  const evening = {};
  for (const m of MARKETS) {
    const upto = daily[m.key].filter(x => x.date <= D);
    evening[m.key] = { series: upto, engine: engineFor(m.key, upto) };
  }
  const nextDate = daily['코스피'].find(x => x.date > D)?.date ?? '익일';
  const verification = MARKETS.map(m => {
    const e = morning[m.key].engine;
    const s = evening[m.key].series;
    const actual = (s.at(-1).close / s.at(-2).close - 1) * 100;
    const v = scoreVerification({
      forecast_median: e.f.median, forecast_low: e.f.low, forecast_high: e.f.high,
      probability_up: e.f.probs.up, probability_flat: e.f.probs.flat, probability_down: e.f.probs.down,
      flat_band: e.f.band, sigma: e.f.sigma, call_direction: e.f.call, baselines: e.f.baselines,
    }, actual);
    return { name: m.key, forecast_pct: e.f.median, actual_pct: v.actual_return, direction_hit: v.direction_hit, partial: v.partial_hit, in_range: v.in_range, abs_error: v.abs_error, winkler: v.winkler, cause: '재현 실행 — 원인분류 생략' };
  });
  const structEve = MARKETS.map(m => {
    const s = evening[m.key].series;
    const bars = m1[m.key].get(D) ?? [];
    const yClose = s.at(-2).close;
    const st = { name: m.key, prev_day_ret_pct: +((yClose / s.at(-3).close - 1) * 100).toFixed(2), today_ret_pct: +((s.at(-1).close / yClose - 1) * 100).toFixed(2) };
    if (bars.length) {
      const closes = bars.map(b => b.close);
      st.gap_open_pct = +((bars[0].close / yClose - 1) * 100).toFixed(2);
      st.intraday_high_pct = +((Math.max(...closes) / yClose - 1) * 100).toFixed(2);
      st.intraday_low_pct = +((Math.min(...closes) / yClose - 1) * 100).toFixed(2);
    }
    return st;
  });
  const closePayload = {
    replay_note: `과거 재현: ${lbl(D)} 16:10 시점 데이터만 사용. 뉴스 미제공(재현 불가) — 명시할 것.`,
    now_kst: `${D} 16:10`, phase: 'close', allow_websearch: false,
    span: { start: `${lbl(D)} 종가`, end: `${lbl(nextDate)} 종가` },
    data_state: {
      price_asof: D, quality: 'A', notes: ['과거 재현 실행'],
      flow_basis: lastFlowBefore(D) ? `확정 최신 ${lastFlowBefore(D).date} · 당일(${lbl(D)}) 수급은 미확정` : '미제공',
      disclosure_latest: `당일(${lbl(D)})까지`, news: '미제공(과거 재현)',
    },
    engine: MARKETS.map(m => engineRow(evening[m.key].engine)),
    price_structure: structEve,
    investor_flow: lastFlowBefore(D) ? { ...lastFlowBefore(D), label: `제한된 대형주 바스켓 참고지표(확정 ${lastFlowBefore(D).date}, 당일분 미확정)` } : null,
    disclosures: { recent: await discBefore(D, true), stale: false },
    verification, rolling_buckets: { note: '재현 실행 — 누적 통계 없음' },
  };
  const close = composeReport(closePayload);
  const closeText = `⏪ 과거 재현 (${lbl(D)} 저녁 16:10 시점, 엔진 ${ENGINE_VERSION} · 원장 미기록)\n\n${close.text ?? `합성 실패: ${close.error}`}`;
  console.log(closeText);
  await sendTg(closeText);
}

main().catch(e => { console.error('재현 실패:', e); process.exit(1); });
