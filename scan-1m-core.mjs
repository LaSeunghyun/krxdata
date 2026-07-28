/**
 * scan-1m-core.mjs — 1분봉 기반 스윙 후보 스캔의 공용 코어 (2026-07-27)
 * scan-1m-now.mjs(수동 조회)와 shadow-1m.mjs(라이브 섀도우 적재)가 **같은 계산**을 쓰도록 분리했다.
 *
 * ⚠️ 1분봉은 방향 예측용이 아니다(스캘핑 100조합 전부 음수, 2026-07-25). 여기선
 *    "실행품질·추세구조"(VWAP 우위·저점상승·되돌림·노이즈폭)만 뽑고, 스윙 논지는 일봉이 담당한다.
 * 데이터: KIS 분봉(FHKST03010200) — 라이브봇 Toss 세션과 경합 0 / 일봉은 로컬 candles-daily.jsonl.
 */
import { createReadStream } from 'fs';
import readline from 'readline';
import { getMinuteBars } from './kis-api.js';

export const MIN_TURNOVER = 30e8;   // 라이브 유동성 하드필터: 20일 평균 거래대금 30억
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 일봉 문맥 로드 + 유동성 필터. freshDate 이전에 끝난 종목(거래정지/폐지) 제외 */
export async function loadDaily({ file = 'candles-daily.jsonl', freshDate } = {}) {
  const daily = new Map();
  let maxDate = '';
  const rows = [];
  await new Promise((res) => {
    const rl = readline.createInterface({ input: createReadStream(file) });
    rl.on('line', (l) => {
      if (!l.trim()) return;
      let j; try { j = JSON.parse(l); } catch { return; }
      if (!j.d?.length || j.c.length < 130) return;
      if (j.d.at(-1) > maxDate) maxDate = j.d.at(-1);
      rows.push(j);
    });
    rl.on('close', res);
  });
  // 기준일: 파일 내 "최신"이 아니라 **과반 종목이 가진 최신 거래일**.
  //   (2026-07-27 실측 결함: 몇 종목만 갱신되면 max가 그 날짜로 튀어 유니버스가 몇 종목으로 붕괴한다)
  const cnt = new Map();
  for (const j of rows) cnt.set(j.d.at(-1), (cnt.get(j.d.at(-1)) ?? 0) + 1);
  let acc = 0, majority = maxDate;
  for (const [dt, n] of [...cnt.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    acc += n;
    if (acc >= rows.length * 0.5) { majority = dt; break; }
  }
  const fresh = freshDate ?? majority;
  for (const j of rows) {
    if (j.d.at(-1) < fresh) continue;
    const n = j.c.length;
    let tv = 0; for (let i = n - 20; i < n; i++) tv += j.c[i] * j.v[i];
    if (tv / 20 < MIN_TURNOVER) continue;
    let ma20 = 0; for (let i = n - 20; i < n; i++) ma20 += j.c[i];
    let ma60 = 0; for (let i = n - 60; i < n; i++) ma60 += j.c[i];
    let hi120 = 0; for (let i = n - 120; i < n; i++) hi120 = Math.max(hi120, j.h[i]);
    let tr = 0; for (let i = n - 14; i < n; i++) tr += Math.max(j.h[i] - j.l[i], Math.abs(j.h[i] - j.c[i - 1]), Math.abs(j.l[i] - j.c[i - 1]));
    let vol20 = 0; for (let i = n - 20; i < n; i++) vol20 += j.v[i];
    // V_bounce용: 전일까지 19일 최저가와 그게 며칠 전인지 (오늘 저가는 분봉에서 따로 계산)
    let low19 = Infinity, low19I = n - 1;
    for (let i = n - 19; i < n; i++) if (j.l[i] < low19) { low19 = j.l[i]; low19I = i; }
    daily.set(j.code, {
      prevClose: j.c[n - 1], ma20: ma20 / 20, ma60: ma60 / 60, hi120,
      atrPct: (tr / 14) / j.c[n - 1] * 100, vol20: vol20 / 20, turnover: tv / 20,
      ret20: j.c[n - 1] / j.c[n - 21] - 1,
      low19, low19Ago: n - low19I,     // 오늘 기준 며칠 전 저점인지(전일=1)
    });
  }
  return { daily, freshDate: fresh };
}

/** 라이브 marketRegime과 동일 판정식을 임의 종가배열에 적용 */
export function regimeOfSeries(c) {
  const i = c.length - 1;
  const avg = (n) => { let s = 0; for (let k = i - n + 1; k <= i; k++) s += c[k]; return s / n; };
  const ma20 = avg(20), ma60 = avg(60), ret5 = (c[i] / c[i - 5] - 1) * 100;
  if (c[i] > ma20 && ma20 > ma60) return 'UP';
  if (c[i] < ma20 && ret5 < -3) return 'DOWN';
  return 'NEUTRAL';
}

/**
 * 전 종목 1분봉 조회 + 채점. 반환: { scored, meta }
 * @param opts.maxN 0=유동성통과 전체 / N=앞 N개(스모크테스트)
 * @param opts.paceMs KIS 페이싱(기본 70ms ≈ 14TPS, 실전 한도 20TPS 이하)
 */
/**
 * @param opts.times ['1000','1300','1520'] — **판단 시각 리스트**. 분봉을 한 번 받아두고 각 시각까지의
 *   봉만 잘라 리플레이하므로 **추가 API 비용 0**. 1분마다 콜하는 것과 달리 독립 표본은 날짜 수로 결정되니
 *   장중 몇 개 시점만 재는 게 비용/정보 균형점이다. 미지정=baseHHMM 1회.
 */
export async function scanNow({ maxN = 0, paceMs = 70, log = () => {}, freshDate, windowMin = 0, baseHHMM = null, times = null, trigger = false, triggerStep = 1 } = {}) {
  const { daily, freshDate: fresh } = await loadDaily({ freshDate });
  const MKT = daily.get('005930');
  if (!MKT) throw new Error('005930 일봉 없음 — 시장 프록시 계산 불가');
  const MKT_RET20 = MKT.ret20;

  // ★ 기준시각을 **전 종목 동일**하게 고정한다(2026-07-27 결함 수정).
  //   전엔 콜마다 각자의 벽시계를 써서 520종목 스캔 2분 동안 종목별 관측창이 최대 2분 엇갈렸다 → 비교 불가.
  const kst = new Date(Date.now() + 9 * 3600_000);
  const baseMin = baseHHMM
    ? Number(String(baseHHMM).slice(0, 2)) * 60 + Number(String(baseHHMM).slice(2, 4))
    : kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const hm = (t) => String(Math.floor(t / 60)).padStart(2, '0') + String(t % 60).padStart(2, '0');
  const nowHM = hm(baseMin);
  const elapsed = Math.max(1, baseMin - 540);                 // 09:00 이후 경과분
  // 관측창: windowMin=0이면 **당일 전 구간**(09:00~기준시각). KIS 분봉은 당일만 조회 가능 = 오늘 안 받으면 영구 소실.
  const win = Math.min(windowMin > 0 ? windowMin : elapsed, elapsed);
  const calls = Math.max(1, Math.ceil(win / 30));
  const cutHM = hm(baseMin - win);

  // 판단 시각: 기준시각 이하만 유효(미래 시점은 데이터가 없다)
  const DT = (times?.length ? times.map(String).filter(t => t <= nowHM) : [nowHM]);
  if (!DT.length) throw new Error(`판단 시각이 모두 기준시각(${nowHM}) 이후 — 확인 필요`);

  let codes = [...daily.keys()];
  if (maxN > 0) codes = codes.slice(0, maxN);
  log(`유동성 통과 ${codes.length}종목 (기준일 ${fresh}) — 분봉 조회: 기준 ${nowHM} · 관측창 ${win}분(${cutHM}~${nowHM}) · ${calls}콜/종목 · 판단시각 ${DT.join(',')}`);

  const scored = [], triggers = [];
  let done = 0, fail = 0;
  for (const code of codes) {
    let r = null;
    try {
      const seen = new Set();
      let bars = [], now = 0, prevClose = null, acmlVol = null;
      for (let k = 0; k < calls; k++) {
        const a = await getMinuteBars(code, hm(baseMin - 30 * k) + '00');
        await sleep(paceMs);
        if (k === 0) { now = a.now; prevClose = a.prevClose; acmlVol = a.acmlVol; }
        for (const b of a.bars) if (!seen.has(b.hhmm)) { seen.add(b.hhmm); bars.push(b); }
        if (a.bars.length === 0) break;                        // 개장 이전 구간 도달
      }
      bars = bars.filter(b => b.hhmm >= cutHM && b.hhmm <= nowHM).sort((x, y) => x.hhmm.localeCompare(y.hhmm));
      if (bars.length >= 10 && now) r = { code, now, prevClose: prevClose ?? daily.get(code).prevClose, acmlVol, bars };
    } catch { /* 조회 실패는 건너뜀 */ }
    if (!r) { fail++; }
    else {
      // 조건 최초 성립 분 (페이퍼 진입용 — 라이브 진입시점 근사)
      if (trigger) for (const g of firstTriggers(r, daily.get(code), { MKT_RET20 }, { step: triggerStep })) triggers.push({ code, ...g });
      // 판단 시각별 리플레이: 해당 시각까지의 봉만 사용(룩어헤드 차단).
      //   현재가·누적거래량도 **그 시점 값**으로 재계산한다(KIS acml_vol은 조회시점 값이라 과거 시점엔 못 씀).
      for (const t of DT) {
        const cut = r.bars.filter(b => b.hhmm <= t);
        if (cut.length < 10) continue;
        const vSum = cut.reduce((s, b) => s + b.v, 0);
        const el = Math.max(1, Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4)) - 540);
        scored.push({
          at: t,
          ...score({ code: r.code, now: cut.at(-1).c, prevClose: r.prevClose, acmlVol: vSum, bars: cut }, daily.get(code), { MKT_RET20, elapsed: el }),
        });
      }
    }
    if (++done % 100 === 0) log(`  ${done}/${codes.length} (실패 ${fail})`);
  }
  const MKT_NOW = scored.find(s => s.code === '005930' && s.at === DT.at(-1))?.now ?? 0;
  log(`분봉 확보 ${done - fail}종목 / 실패 ${fail} · 판단시각 ${DT.join(',')} → ${scored.length}행${trigger ? ` · 최초성립 ${triggers.length}건` : ''} | 기준 ${nowHM} (경과 ${elapsed}분, 창 ${win}분)`);
  return { scored, triggers, meta: { nowHM, elapsed, win, calls, fail, times: DT, freshDate: fresh, mktNow: MKT_NOW, mktRet20: MKT_RET20, mkt: MKT } };
}

/**
 * 조건 **최초 성립 분** 탐색 (2026-07-27, 사용자 제안 "1분마다 업데이트").
 * 실시간 1분 폴링 대신 이미 받아둔 380봉을 분 단위로 리플레이한다 — 결과 동일, API 추가비용 0,
 * 장중 상주 프로세스 불필요. 라이브봇(5초 스캔 후 즉시 매수)의 진입 시점을 근사하는 게 목적이다.
 * @returns [{variant, at, s}] — 룰별 최초 성립 시각 1건씩(성립 안 하면 없음)
 */
export function firstTriggers(r, d, ctx, { minBars = 30, step = 1 } = {}) {
  const out = [], hit = new Set();
  const GATE = { A_hi120: 'gatesA', B_rs: 'gates', C_self: 'gatesC', D_nochase: 'gatesD', V_bounce: 'gatesV', V2_intra: 'gatesV2', V3_ubase: 'gatesV3' };
  for (let i = minBars - 1; i < r.bars.length; i += step) {
    if (hit.size === Object.keys(GATE).length) break;
    const cut = r.bars.slice(0, i + 1);
    const t = cut.at(-1).hhmm;
    const el = Math.max(1, Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4)) - 540);
    const s = score({ code: r.code, now: cut.at(-1).c, prevClose: r.prevClose, acmlVol: cut.reduce((a, b) => a + b.v, 0), bars: cut }, d, { ...ctx, elapsed: el });
    for (const [variant, key] of Object.entries(GATE)) {
      if (hit.has(variant) || s[key].length) continue;
      hit.add(variant);
      out.push({ variant, at: t, s });
    }
  }
  return out;
}

/** 종목 1건 채점 — 분봉 지표 + 일봉 문맥 + 3가지 게이트(A/B/C) */
export function score(r, d, { MKT_RET20, elapsed }) {
  let pv = 0, vv = 0, hi = 0, lo = Infinity, tr1 = 0;
  const B = r.bars;
  for (let i = 0; i < B.length; i++) {
    const b = B[i];
    pv += ((b.h + b.l + b.c) / 3) * b.v; vv += b.v;
    hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
    if (i > 0) tr1 += Math.max(b.h - b.l, Math.abs(b.h - B[i - 1].c), Math.abs(b.l - B[i - 1].c));
  }
  const vwap = vv > 0 ? pv / vv : r.now;
  const atr1Pct = B.length > 1 ? (tr1 / (B.length - 1)) / r.now * 100 : 0;
  const pos = hi > lo ? (r.now - lo) / (hi - lo) : 0.5;
  const vwapPrem = (r.now / vwap - 1) * 100;
  const mom10 = B.length >= 11 ? (r.now / B.at(-11).c - 1) * 100 : 0;
  const dayRet = (r.now / r.prevClose - 1) * 100;
  const volPace = d.vol20 > 0 && r.acmlVol ? (r.acmlVol / (elapsed / 390)) / d.vol20 : 0;
  const hiProx = r.now / d.hi120;
  const rs20 = (d.ret20 - MKT_RET20) * 100;

  // 종목 자체 분봉 추세 (시장 참조 0)
  const n3 = Math.floor(B.length / 3);
  const segLow = [0, 1, 2].map(k => Math.min(...B.slice(k * n3, k === 2 ? B.length : (k + 1) * n3).map(b => b.l)));
  const higherLows = (segLow[1] > segLow[0] ? 1 : 0) + (segLow[2] > segLow[1] ? 1 : 0);
  const half = Math.floor(B.length / 2);
  const vwapOf = (a) => { let p = 0, v = 0; for (const b of a) { p += ((b.h + b.l + b.c) / 3) * b.v; v += b.v; } return v > 0 ? p / v : 0; };
  const vwapSlope = (vwapOf(B.slice(half)) / (vwapOf(B.slice(0, half)) || 1) - 1) * 100;
  const upBars = B.filter(b => b.c > b.o).length / B.length;
  const upVolFrac = (() => { let u = 0, t = 0; for (const b of B) { t += b.v; if (b.c > b.o) u += b.v; } return t > 0 ? u / t : 0; })();
  const pullback = (hi - r.now) / hi * 100;
  const selfUp = r.now > d.ma20 && d.ma20 > d.ma60;
  // ── 장중 V자 지표 (2026-07-27 추가) ────────────────────────────────────────
  //   사용자 정정: "노타처럼 **오늘 하루 안에서** 떨어졌다 바닥 다지고 반등한 모양"을 찾으려면 이 값들이 필요하다.
  //   V_bounce(일봉)와 완전히 다른 축이다. 분봉은 당일만 조회 가능 → 저장 안 하면 소급 불가.
  let vLoIdx = 0, vLo = Infinity;
  for (let i = 0; i < B.length; i++) if (B[i].l < vLo) { vLo = B[i].l; vLoIdx = i; }
  let vPreHi = 0; for (let i = 0; i <= vLoIdx; i++) vPreHi = Math.max(vPreHi, B[i].h);
  const dropPct = vPreHi > 0 ? (vLo / vPreHi - 1) * 100 : 0;               // 저점 전 고가 → 저점 낙폭
  const reboundPct = vLo > 0 ? (r.now / vLo - 1) * 100 : 0;                // 저점 → 현재 반등
  const recoverPct = vPreHi > vLo ? (r.now - vLo) / (vPreHi - vLo) * 100 : 0; // 낙폭 회복률(100%↑=전고 돌파)
  const lowPos = B.length > 1 ? vLoIdx / (B.length - 1) * 100 : 0;          // 저점 시각 위치(%)
  let baseHold = 0; for (let i = vLoIdx; i < B.length; i++) if (B[i].c <= vLo * 1.01) baseHold++; // 바닥권 유지 분

  // 전 구간 관측일 때만 의미 있는 구조 지표(2026-07-27 추가) — 창이 짧으면 자동으로 근사치가 된다
  const openGap = (B[0].o / r.prevClose - 1) * 100;                       // 시가갭 %
  const amHigh = Math.max(...B.slice(0, Math.min(60, B.length)).map(b => b.h)); // 첫 60분 고가
  const amBreak = r.now > amHigh;                                          // 오전 고점 돌파 여부
  // 최근 60분 부분집합 — 전 구간 지표와 별개로 "마감 흐름"을 따로 보존
  const R60 = B.slice(-60);
  const hi60 = Math.max(...R60.map(b => b.h));
  const pullback60 = (hi60 - r.now) / hi60 * 100;
  const h60 = Math.floor(R60.length / 2);
  const vwapSlope60 = R60.length >= 10 ? (vwapOf(R60.slice(h60)) / (vwapOf(R60.slice(0, h60)) || 1) - 1) * 100 : 0;

  const gatesB = [];
  if (r.now < 2000) gatesB.push('저가주');
  if (dayRet <= 0) gatesB.push('전일대비 음수');
  if (r.now < vwap) gatesB.push('VWAP 아래');
  if (r.now < d.ma20) gatesB.push('MA20 아래');
  if (rs20 <= 0) gatesB.push('시장대비 약세');
  const gatesA = hiProx < 0.90 ? [...gatesB, '120일고가 -10%↓'] : gatesB;
  // D안(2026-07-27, 평가 결과로 추가): B안 + **당일 상승률 상한 8%**.
  //   근거: 첫 평가 3건 전부 선정오류, 진입시 당일상승 평균 +18.1%, RR 0.52(여력 4.05% / 위험 -9.25%).
  //   이미 크게 오른 뒤 진입하면 남은 여력은 작고 되돌림은 전액 부담이다 → 추격 구간을 잘라낸다.
  const gatesD = dayRet > 8 ? [...gatesB, `당일 +${dayRet.toFixed(1)}% 추격`] : gatesB;
  // V안(2026-07-27, 노타형 바닥반등): 3.4년 소급 리프트 2.27(2위)로 진입 신호 근거 확보.
  //   ⚠️ 단 RR 1.32 ≈ 랜덤 1.28 — **상승·하락이 같이 큰 종목**을 골라내는 것이라 청산이 위험 꼬리를 잘라야 엣지가 된다.
  //   조건: 20일 저점이 1~5일 전 · 그 저점 대비 반등 ≥15% · 120일고가 대비 ≤80% · 거래량 ≥1.5x
  const todayLow = Math.min(...B.map(b => b.l));
  const vLow = Math.min(d.low19, todayLow);
  const vSince = todayLow < d.low19 ? 0 : d.low19Ago;      // 오늘이 저점이면 0 → 탈락(아직 반등 확인 안 됨)
  const vBounce = (r.now / vLow - 1) * 100;
  const gatesV = [];
  if (r.now < 2000) gatesV.push('저가주');
  if (!(vSince >= 1 && vSince <= 5)) gatesV.push(vSince === 0 ? '오늘이 저점(반등 미확인)' : '저점 5일 초과');
  if (vBounce < 15) gatesV.push(`반등 ${vBounce.toFixed(1)}% <15%`);
  if (hiProx > 0.80) gatesV.push('하락폭 부족(고가비 80%초과)');
  if (volPace < 1.5) gatesV.push('거래량 1.5x미만');
  // V2안(2026-07-27): **장중 분봉 V자**. V_bounce(일봉)와 다른 축 — 오늘 실측 7종목의 공통 조건.
  //   ① 오전 급락 있었음(저점 전 고가→저점 ≤ -5%) ② 저점이 장중(10~80% 지점, 개장 직후/막판 제외)
  //   ③ **오전 고가 돌파**(회복률 ≥100%) = 확인 시점 ④ 양봉(현재가 > 시가)
  //   ⚠️ 분봉은 소급 검증이 불가능하다(KIS 당일만). 그래서 이 룰의 채택 경로는 백테가 아니라
  //      `shadow_1m_metrics` 전 종목 지표 × 이후 수익률 조인(2~3주)이다. 페이퍼 진입은 **청산 조합 측정용**.
  const gatesV2 = [];
  if (r.now < 2000) gatesV2.push('저가주');
  if (dropPct > -5) gatesV2.push(`급락 없음(${dropPct.toFixed(1)}%)`);
  if (!(lowPos >= 10 && lowPos <= 80)) gatesV2.push(`저점위치 ${lowPos.toFixed(0)}% (10~80% 밖)`);
  if (recoverPct < 100) gatesV2.push(`회복률 ${recoverPct.toFixed(0)}% <100%(전고 미돌파)`);
  if (r.now <= B[0].o) gatesV2.push('음봉');
  // V3안(2026-07-27): **U자** — V2와 조건은 같고 **바닥 유지 30분 이상**을 추가 요구.
  //   노타는 저점(10:56) 이후 3시간을 저점권에서 다졌다(U자). 오늘 7종목의 바닥유지 중위는 9분(급반등 V자).
  //   두 유형이 섞이면 서로 상쇄될 수 있어 분리한다. V3 ⊂ V2 (V3 통과면 V2도 통과).
  const gatesV3 = [...gatesV2];
  if (baseHold < 30) gatesV3.push(`바닥유지 ${baseHold}분 <30분(급반등형)`);
  const gatesC = [];
  if (r.now < 2000) gatesC.push('저가주');
  if (!selfUp) gatesC.push('종목레짐 UP 아님');
  if (r.now < vwap) gatesC.push('VWAP 아래');
  if (vwapSlope <= 0) gatesC.push('VWAP 하향');
  if (pullback > 1.5) gatesC.push('고점대비 되돌림 1.5%↑');
  if (higherLows < 1) gatesC.push('저점 상승 없음');

  const scoreAB =
    30 * Math.min(1, Math.max(0, pos)) +
    20 * Math.min(1, Math.max(0, vwapPrem / 1.0)) +
    10 * Math.min(1, Math.max(0, 1 - Math.abs(atr1Pct - 0.15) / 0.35)) +
    20 * Math.min(1, Math.max(0, (hiProx - 0.90) / 0.10)) +
    20 * Math.min(1, Math.max(0, (volPace - 0.8) / 1.2));
  const scoreC =
    25 * (higherLows / 2) +
    20 * Math.min(1, Math.max(0, vwapSlope / 0.5)) +
    20 * Math.min(1, Math.max(0, (upVolFrac - 0.5) / 0.25)) +
    15 * Math.min(1, Math.max(0, (upBars - 0.4) / 0.3)) +
    10 * Math.min(1, Math.max(0, 1 - pullback / 1.5)) +
    10 * Math.min(1, Math.max(0, 1 - Math.abs(atr1Pct - 0.15) / 0.35));

  return {
    code: r.code, now: r.now, prevClose: r.prevClose, ...d,
    vwap, atr1Pct, pos, vwapPrem, mom10, dayRet, volPace, hiProx, rs20,
    higherLows, vwapSlope, upBars, upVolFrac, pullback, selfUp,
    openGap, amBreak, pullback60, vwapSlope60, bars: B.length,
    dropPct, reboundPct, recoverPct, lowPos, baseHold, loHHMM: B[vLoIdx].hhmm, gatesV2, gatesV3,
    score: scoreAB, scoreC, gates: gatesB, gatesA, gatesC, gatesD, gatesV, vBounce, vSince,
  };
}
