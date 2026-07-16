#!/usr/bin/env node
/**
 * sweep-bb-intraday.mjs — bb-revert/bb-squeeze 파라미터 스윕 (인트라데이, 1분봉)
 *
 *   1분봉은 최근 수개월치만 존재해 스윙과 같은 2023~/2025~ Train/Validation 분할이 성립하지 않는다.
 *   가용 창(기본 backtest-intraday.mjs 창과 동일, 2026-03-16~2026-06-11) 전체를 시간순 60/40 분할한다.
 *   표본이 작아(전략당 트레이드 수백 건 이하) confirmation이 아니라 falsification 목적임을 전제로,
 *   사전 등록한 kill criterion — train net expectancy/trade < +0.15% 또는 gross expectancy <= 0 —
 *   에 걸리면 validation 없이 그 조합은 폐기한다(사후 임계값 조정 금지).
 *
 * 실행: node sweep-bb-intraday.mjs
 *   (토스 1분봉 API 호출 — 조합당 수십초~수분, 전체 그리드 실행에 시간이 걸림)
 */
import { execFileSync } from 'child_process';

const FULL_FROM = '20260316';
const FULL_TO = '20260611';
const KILL_NET_PCT = 0.15; // train net expectancy/trade 최소 기준 (%)

function splitDate(from, to, trainFrac) {
  const d0 = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00Z`);
  const d1 = new Date(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00Z`);
  const mid = new Date(d0.getTime() + (d1.getTime() - d0.getTime()) * trainFrac);
  return mid.toISOString().slice(0, 10).replace(/-/g, '');
}
const TRAIN_TO = splitDate(FULL_FROM, FULL_TO, 0.6);
const validFromDate = new Date(`${TRAIN_TO.slice(0, 4)}-${TRAIN_TO.slice(4, 6)}-${TRAIN_TO.slice(6, 8)}T00:00:00Z`);
validFromDate.setUTCDate(validFromDate.getUTCDate() + 1);
const VALID_FROM = validFromDate.toISOString().slice(0, 10).replace(/-/g, '');

console.log(`시간분할: Train ${FULL_FROM}~${TRAIN_TO} (60%) / Validation ${VALID_FROM}~${FULL_TO} (40%)`);
console.log('1분봉 데이터 한계로 스윙식 연도 분리(2023/2025) 대신 가용 구간 시간순 분할 사용. Falsification 목적, confirmation 불가 전제.\n');

const GRIDS = {
  'bb-revert': {
    flags: (p) => ['--bbwindow', String(p.bbWindow), '--bbk', String(p.bbK), '--mintarget', String(p.minTargetPct)],
    combos: (() => {
      const out = [];
      for (const bbWindow of [20, 40, 60])
        for (const bbK of [2.0, 2.5])
          for (const minTargetPct of [0.6, 1.0])
            out.push({ bbWindow, bbK, minTargetPct });
      return out;
    })(),
    fmt: (p) => `bbWindow=${p.bbWindow} bbK=${p.bbK} minTarget=${p.minTargetPct}%`,
  },
  'bb-squeeze': {
    flags: (p) => ['--bbwindow', String(p.bbWindow), '--sqzquantile', String(p.sqzQuantile), '--tpr', String(p.tpR)],
    combos: (() => {
      const out = [];
      for (const bbWindow of [20, 40])
        for (const sqzQuantile of [0.15, 0.25])
          for (const tpR of [2, 3])
            out.push({ bbWindow, sqzQuantile, tpR });
      return out;
    })(),
    fmt: (p) => `bbWindow=${p.bbWindow} sqzQuantile=${p.sqzQuantile} tpR=${p.tpR}`,
  },
};

function runOne(strat, extraFlags, from, to) {
  const args = ['backtest-intraday.mjs', '--strategies', strat, '--from', from, '--to', to, ...extraFlags];
  const out = execFileSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 1_800_000 });
  const re = new RegExp(`EXPECTANCY\\s+${strat}\\s+gross=(-?[\\d,]+)원\\((-?[\\d.]+)%\\/건\\)\\s+net=(-?[\\d,]+)원\\((-?[\\d.]+)%\\/건\\)\\s+n=(\\d+)`);
  const m = out.match(re);
  if (!m) return null;
  return { grossWon: +m[1].replace(/,/g, ''), grossPct: +m[2], netWon: +m[3].replace(/,/g, ''), netPct: +m[4], n: +m[5] };
}

const allResults = {};
for (const [strat, def] of Object.entries(GRIDS)) {
  console.log(`\n=== ${strat} 스윕: Train ${FULL_FROM}~${TRAIN_TO} (${def.combos.length}조합) ===`);
  const survivors = [];
  const killed = [];
  for (let i = 0; i < def.combos.length; i++) {
    const p = def.combos[i];
    try {
      const r = runOne(strat, def.flags(p), FULL_FROM, TRAIN_TO);
      if (!r) { console.log(`[${i + 1}/${def.combos.length}] ${def.fmt(p)} — 파싱 실패`); continue; }
      const kill = r.netPct < KILL_NET_PCT || r.grossPct <= 0;
      console.log(`[${i + 1}/${def.combos.length}] ${def.fmt(p)} | gross ${r.grossPct.toFixed(3)}%/건 net ${r.netPct.toFixed(3)}%/건 n=${r.n} ${kill ? '⛔ KILL(validation 생략)' : '✅ 통과'}`);
      if (kill) killed.push({ p, r }); else survivors.push({ p, r });
    } catch (e) { console.log(`[${i + 1}/${def.combos.length}] ${def.fmt(p)} — 오류: ${e.message.slice(0, 100)}`); }
  }
  console.log(`\n${strat}: train ${def.combos.length}조합 중 kill criterion 통과 ${survivors.length}건 (net>=+${KILL_NET_PCT}% AND gross>0), 폐기 ${killed.length}건`);

  const validResults = [];
  if (survivors.length) {
    console.log(`\n=== ${strat} Validation ${VALID_FROM}~${FULL_TO} (통과 ${survivors.length}조합만 재검증) ===`);
    for (const { p, r } of survivors) {
      const v = runOne(strat, def.flags(p), VALID_FROM, FULL_TO);
      console.log(`TRAIN ${def.fmt(p)} | gross ${r.grossPct.toFixed(3)}%/건 net ${r.netPct.toFixed(3)}%/건 n=${r.n}`);
      console.log(`VALID ${v ? `gross ${v.grossPct.toFixed(3)}%/건 net ${v.netPct.toFixed(3)}%/건 n=${v.n}` : '실패'}`);
      if (v) validResults.push({ p, train: r, valid: v });
    }
  } else {
    console.log(`\n${strat}: train에서 전부 kill criterion 미달 — validation 생략 (사전 등록 기준, 사후 조정 금지)`);
  }
  allResults[strat] = { survivors, killed, validResults };
}

console.log('\n=== 최종 판정 ===');
for (const [strat, res] of Object.entries(allResults)) {
  const adopted = res.validResults.filter(v => v.valid.netPct >= KILL_NET_PCT && v.valid.grossPct > 0);
  console.log(`${strat}: ${adopted.length ? `채택 후보 ${adopted.length}건 (train+valid 둘 다 기준 통과)` : '채택 후보 없음 — 기각'}`);
}
console.log(`\n※ 표본 크기 한계(수개월 1분봉)상 이 결과는 falsification(엣지 없음을 배제하지 못함)이지 confirmation이 아님. 참고: docs/superpowers/specs/2026-07-15-krxdata-bollinger-band-strategy-design.md §2.3`);
