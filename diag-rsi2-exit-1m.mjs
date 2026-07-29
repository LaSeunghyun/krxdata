/**
 * diag-rsi2-exit-1m.mjs — rsi2 청산: 검증된 규칙 vs 라이브 규칙 (분 단위 대조, 2026-07-29)
 *
 * 배경: 라이브 봇은 rsi2 보유분에 트레일 -6% + 부분익절 +6/+12%를 30초 루프로 적용한다.
 *   백테의 검증된 rsi2 청산은 **트레일 없음** — 하드손절 -7%(종가 판정) · MA5 회귀 익절 · maxHoldR 만기.
 *   커밋 이력: TRAIL_PCT는 1af671a "unified continuous stock trader (Toss, coin-style)" 단일 커밋에서
 *   들어왔고 이후 sub 분기가 붙은 적이 없다 = **코인봇 이식 잔재**(코인엔 서브전략이 없다).
 *
 * 일봉 백테는 진입 당일 청산을 재현할 수 없다(그날 저가가 진입 전인지 후인지 모름).
 *   그런데 07-29 실거래 피해가 정확히 진입당일이었다 — 12건 트레일손절 전부 진입 2시간 내.
 *   그래서 분봉으로 판정한다. 두 정책은 **동일 진입**을 공유하므로 차이는 순수히 청산에서 온다.
 *
 * 실행: node diag-rsi2-exit-1m.mjs [--dir data-1m] [--entryhm 1000] [--maxhold 5]
 */
import { createReadStream, readdirSync, readFileSync } from 'fs';
import readline from 'readline';
import { join } from 'path';

const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DIR = String(argOf('--dir', 'data-1m'));
const ENTRY_HM = Number(argOf('--entryhm', 1000));   // 진입 시각(HHMM) — 오늘 실거래 진입이 10~13시대였다
const MAXHOLD = Number(argOf('--maxhold', 5));       // = combo-v2 maxHoldR
const RSI_MAX = 10, VOL_MIN = 1.25, COST = 0.33;
const TRAIL = 6, HARD = 7, TP1 = 6, TP2 = 12;

const KST = (s) => new Date(s * 1000 + 9 * 3_600_000);
const dayOf = (s) => KST(s).toISOString().slice(0, 10).replace(/-/g, '');
const hmOf = (s) => { const d = KST(s); return d.getUTCHours() * 100 + d.getUTCMinutes(); };

// ── 일봉 로드 ────────────────────────────────────────────────────────────────
// ★ 2026-07-29 사고 대응: 이전엔 2,576종목 전량을 Map에 올렸다(110MB 파일 → JS 객체 수백MB).
//   956MB VM에서 라이브 봇과 함께 돌다가 메모리 고갈로 OS가 응답 불가 → 재부팅, 봇 64분 정지.
//   분봉이 있는 종목만 필요하므로 **미리 코드 집합으로 필터**한다(2,576 → 234, 90% 감소).
const NEED = new Set(readdirSync(DIR).filter(f => f.endsWith('.jsonl')).map(f => f.replace('.jsonl', '')));
NEED.add('005930');                                  // 레짐 프록시는 항상 필요
const HIST = new Map();
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => {
    if (!l.trim()) return;
    // JSON.parse 전에 코드로 걸러 파싱 비용·메모리를 아낀다
    const m = l.slice(0, 40).match(/"code"\s*:\s*"(\d{6})"/);
    if (!m || !NEED.has(m[1])) return;
    try { const j = JSON.parse(l); if (j.c?.length >= 200) HIST.set(j.code, j); } catch {}
  });
  rl.on('close', res);
});
const mkt = HIST.get('005930');
const mIdx = new Map(mkt.d.map((d, i) => [d, i]));
console.log(`일봉 ${HIST.size}종목 로드`);

function rsi2At(c, i) {
  if (i < 2) return 50;
  let up = 0, dn = 0;
  for (let j = i - 1; j <= i; j++) { const ch = c[j] - c[j - 1]; if (ch > 0) up += ch; else dn -= ch; }
  return up + dn === 0 ? 50 : (up / (up + dn)) * 100;
}
/** 삼전 프록시 레짐 (라이브 marketRegime과 동일식) */
function regimeAt(mi) {
  if (mi < 60) return null;
  let ma20 = 0, ma60 = 0;
  for (let k = mi - 19; k <= mi; k++) ma20 += mkt.c[k];
  for (let k = mi - 59; k <= mi; k++) ma60 += mkt.c[k];
  ma20 /= 20; ma60 /= 60;
  const ret5 = (mkt.c[mi] / mkt.c[mi - 5] - 1) * 100;
  if (mkt.c[mi] > ma20 && ma20 > ma60) return 'UP';
  if (mkt.c[mi] < ma20 && ret5 < -3) return 'DOWN';
  return 'NEUTRAL';
}

/** 라이브 정책 — 분 단위: 트레일 + 부분익절 + 하드손절 (진입 당일부터 즉시 적용) */
function exitLive(days, si, bi, entry) {
  let runHi = entry, qty = 1, realized = 0, tp1 = false, tp2 = false;
  for (let di = si; di < Math.min(days.length, si + MAXHOLD); di++) {
    const bars = days[di].bars;
    for (let k = (di === si ? bi + 1 : 0); k < bars.length; k++) {
      const b = bars[k];
      const lv = Math.max(entry * (1 - HARD / 100), runHi * (1 - TRAIL / 100));
      if (b.l <= lv) return { ret: realized + qty * ((Math.min(lv, b.o) / entry - 1) * 100) - COST, day: di - si, why: runHi > entry * (1 + TRAIL / 100) ? 'trail' : (Math.max(entry * (1 - HARD / 100), runHi * (1 - TRAIL / 100)) === entry * (1 - HARD / 100) ? 'hard' : 'trail') };
      if (!tp1 && b.h >= entry * (1 + TP1 / 100)) { realized += 0.5 * TP1; qty -= 0.5; tp1 = true; }
      else if (tp1 && !tp2 && b.h >= entry * (1 + TP2 / 100)) { realized += 0.25 * TP2; qty -= 0.25; tp2 = true; }
      runHi = Math.max(runHi, b.h);
    }
    if (di === si + MAXHOLD - 1 || di === days.length - 1) {
      return { ret: realized + qty * ((bars.at(-1).c / entry - 1) * 100) - COST, day: di - si, why: 'expire' };
    }
  }
  return null;
}

/** MA5 (종가 i까지 포함) */
function ma5At(c, i) { let s = 0, n = Math.min(5, i + 1); for (let k = i - n + 1; k <= i; k++) s += c[k]; return s / n; }

/**
 * 검증된 **판정**(트레일 없음: 하드손절 -7% / MA5 회귀 익절 / MAXHOLD 만기) + 집행방식 3종.
 *   판정은 동일하고 집행가만 다르다 — 사용자 지적("개장가 무조건 청산은 기준이 없다")을 수치로 가른다.
 *   exec='nextopen' : 종가 판정 → 익일 시가. 백테가 쓰는 방식(일봉 lookahead 회피용 제약).
 *   exec='close'    : 종가 판정 → 당일 종가(15:20 마지막 봉). 판정한 가격에 그대로 나간다.
 *   exec='limit'    : 목표가·손절가를 **지정가로 걸어둔다**. MA5(전일까지 기준)를 장중 터치하면 그 가격에 체결.
 *                     조건이 "종가>MA5"보다 약하다(스치기만 해도 나감) → 더 자주, 더 일찍 청산된다.
 */
/**
 * ★ 2026-07-29 정정: 이전 버전은 분봉일(si+d)과 일봉일(ji+d)을 각각 오프셋으로 전진시켰다.
 *   두 데이터셋의 거래일 집합이 다르면(한쪽에 빠진 날) 인덱스가 어긋나 전혀 다른 날짜의 시가를
 *   집행가로 썼다 → 갭 -212%p 같은 실재 불가능한 값이 나왔다. **날짜 문자열로 정렬**한다.
 */
function exitValidated(days, si, entry, j, jIdx, exec) {
  for (let d = 0; d < MAXHOLD; d++) {
    const di = si + d;
    if (di >= days.length) return null;
    const cdi = jIdx.get(days[di].day);                    // ★ 날짜로 조회
    if (cdi == null || cdi < 5) return null;               // 양쪽에 다 있는 날만
    const bars = days[di].bars;

    if (exec === 'limit') {
      // 지정가: 목표가 MA5(전일까지 종가 — 장중 사용이므로 당일 종가 금지) / 손절가 진입×(1-7%)
      const tgt = ma5At(j.c, cdi - 1);
      const stop = entry * (1 - HARD / 100);
      for (const b of bars) {
        if (d === 0 && b.hm < ENTRY_HM) continue;           // 진입 전 봉 제외
        if (b.l <= stop) return { ret: (Math.min(stop, b.o) / entry - 1) * 100 - COST, day: d, why: 'hard' };
        if (b.h >= tgt && tgt > entry) return { ret: (Math.max(tgt, b.o) / entry - 1) * 100 - COST, day: d, why: 'ma5' };
      }
      if (d === MAXHOLD - 1) return { ret: (bars.at(-1).c / entry - 1) * 100 - COST, day: d, why: 'expire' };
      continue;
    }

    const close = j.c[cdi];
    const hit = close <= entry * (1 - HARD / 100) ? 'hard'
      : close > ma5At(j.c, cdi) ? 'ma5'
        : (d >= MAXHOLD - 1 ? 'expire' : null);
    if (hit) {
      if (exec === 'close') return { ret: (close / entry - 1) * 100 - COST, day: d, why: hit };
      const nxt = days[di + 1];                            // nextopen — 분봉 기준 바로 다음 거래일
      if (!nxt) return null;                               // 다음 거래일 분봉이 없으면 판정 불가(추정 금지)
      if (jIdx.get(nxt.day) !== cdi + 1) return null;      // ★ 일봉에서도 연속한 날인지 확인
      return { ret: (nxt.bars[0].o / entry - 1) * 100 - COST, day: d, why: hit };
    }
  }
  return null;
}

// ── 종목 순회 ────────────────────────────────────────────────────────────────
const files = readdirSync(DIR).filter(f => f.endsWith('.jsonl'));
const L = [], V = [], Vc = [], Vl = [];
let nSig = 0, nPair = 0, sameDayL = 0;
const whyL = {}, whyV = {}, whyVl = {};
const gapNextOpen = [];      // 익일시가 − 판정종가 (진입가 대비 %p) — 갭 손익 실측

for (const f of files) {
  const code = f.replace('.jsonl', '');
  const j = HIST.get(code);
  if (!j) continue;
  let o;
  try { o = JSON.parse(readFileSync(join(DIR, f), 'utf8').split('\n')[0]); } catch { continue; }
  const { t, o: op, h, l, c } = o;
  if (!t?.length) continue;

  // 분봉을 일자별로 묶는다 (오래된순)
  const dmap = new Map();
  for (let i = 0; i < t.length; i++) {
    const d = dayOf(t[i]);
    let a = dmap.get(d);
    if (!a) dmap.set(d, a = []);
    a.push({ hm: hmOf(t[i]), o: op[i], h: h[i], l: l[i], c: c[i] });
  }
  const days = [...dmap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, bars]) => ({ day, bars }));
  const dayIdx = new Map(days.map((d, i) => [d.day, i]));
  const jIdx = new Map(j.d.map((d, i) => [d, i]));        // 일봉 날짜 → 인덱스 (정렬용)

  // 일봉에서 rsi2 신호일을 찾고, 그 **다음 거래일**에 진입 (라이브는 전일종가 기준 신호로 당일 매수)
  for (let i = 200; i < j.c.length - 1; i++) {
    if (rsi2At(j.c, i) >= RSI_MAX) continue;
    let v20 = 0; for (let k = i - 19; k <= i; k++) v20 += j.v[k];
    if (!(v20 > 0) || j.v[i] / (v20 / 20) < VOL_MIN) continue;
    const mi = mIdx.get(j.d[i]);
    const rg = mi == null ? null : regimeAt(mi);
    if (rg == null || rg === 'NEUTRAL') continue;      // skipNeutral = 검증된 라이브 설정
    nSig++;

    const entryDay = j.d[i + 1];
    const si = dayIdx.get(entryDay);
    if (si == null) continue;
    const bars = days[si].bars;
    const bi = bars.findIndex(b => b.hm >= ENTRY_HM);
    if (bi < 0) continue;
    const entry = bars[bi].c;
    if (!(entry > 0)) continue;

    const rl = exitLive(days, si, bi, entry);
    const rv = exitValidated(days, si, entry, j, jIdx, 'nextopen');
    const rvc = exitValidated(days, si, entry, j, jIdx, 'close');
    const rvl = exitValidated(days, si, entry, j, jIdx, 'limit');
    if (!rl || !rv || !rvc || !rvl) continue;
    nPair++;
    L.push(rl.ret); V.push(rv.ret); Vc.push(rvc.ret); Vl.push(rvl.ret);
    gapNextOpen.push(rv.ret - rvc.ret);      // 익일시가 집행이 종가 집행보다 얼마나 유리/불리했나
    if (rl.day === 0) sameDayL++;
    whyL[rl.why] = (whyL[rl.why] ?? 0) + 1;
    whyV[rv.why] = (whyV[rv.why] ?? 0) + 1;
    whyVl[rvl.why] = (whyVl[rvl.why] ?? 0) + 1;
  }
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const win = (a) => (a.length ? a.filter(v => v > 0).length / a.length * 100 : 0);

console.log(`\nrsi2 신호 ${nSig.toLocaleString()}건 → 분봉·일봉 둘 다 있는 대조쌍 ${nPair.toLocaleString()}건`);
console.log(`진입 ${ENTRY_HM} · maxHold ${MAXHOLD}일 · 비용 ${COST}%p · 두 정책 동일 진입\n`);
console.log('정책                                  평균      중앙     승률    표본');
console.log('─'.repeat(70));
const row = (n, a) => `${n.padEnd(34)} ${((avg(a) >= 0 ? '+' : '') + avg(a).toFixed(2) + '%').padStart(8)} ${((med(a) >= 0 ? '+' : '') + med(a).toFixed(2) + '%').padStart(8)} ${(win(a).toFixed(1) + '%').padStart(7)}  ${a.length}`;
console.log(row('V1 판정=종가 · 집행=익일시가 (백테)', V));
console.log(row('V2 판정=종가 · 집행=당일종가', Vc));
console.log(row('V3 지정가 (목표 MA5 / 손절 -7%)', Vl));
console.log(row('L  라이브 (트레일6+익절6/12)', L));
console.log(`\nL의 진입당일 청산: ${sameDayL.toLocaleString()}건 (${(sameDayL / nPair * 100).toFixed(1)}%)  ← 일봉 백테가 구조적으로 못 보는 구간`);
console.log(`\n=== 사용자 지적 검증: 익일시가 집행의 갭 손익 ===`);
console.log(`익일시가 − 당일종가 집행 차이: 평균 ${(avg(gapNextOpen) >= 0 ? '+' : '') + avg(gapNextOpen).toFixed(2)}%p · 중앙 ${(med(gapNextOpen) >= 0 ? '+' : '') + med(gapNextOpen).toFixed(2)}%p`);
console.log(`익일시가가 유리했던 비율 ${(gapNextOpen.filter(v => v > 0).length / gapNextOpen.length * 100).toFixed(1)}%`);
console.log(`※ 평균이 0 근처면 갭은 공짜 도박(기댓값 0, 분산만 추가) → 판정한 가격에 나가는 게 낫다.`);
console.log(`※ 유의하게 −면 익일시가 집행은 순손실 → 백테의 제약을 라이브에 옮기면 안 된다.`);
console.log(`\n청산사유`);
console.log(`  V1/V2: ${Object.entries(whyV).map(([k, v]) => k + ' ' + v).join(' · ')}`);
console.log(`  V3   : ${Object.entries(whyVl).map(([k, v]) => k + ' ' + v).join(' · ')}`);
console.log(`  L    : ${Object.entries(whyL).map(([k, v]) => k + ' ' + v).join(' · ')}`);

// 쌍별 승패 — 평균차가 소수 극단값에서 오는지 확인
const pair = (a, b, na, nb) => {
  let aw = 0, bw = 0, tie = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] > b[i] + 0.01) aw++; else if (b[i] > a[i] + 0.01) bw++; else tie++; }
  console.log(`  ${na} ${aw} · ${nb} ${bw} · 무 ${tie}  → ${bw > aw ? nb + ' 우세' : aw > bw ? na + ' 우세' : '동급'}`);
};
console.log(`\n쌍별 비교 (표본 ${L.length})`);
pair(L, V, 'L승', 'V1승');
pair(V, Vc, 'V1승', 'V2승');
pair(Vc, Vl, 'V2승', 'V3승');

// ── 꼬리 집중도: 평균차가 소수 극단값에서 오는지 (평균 -1.54 vs 중앙 +0.17 모순 규명) ──
const g = [...gapNextOpen].sort((a, b) => a - b);      // 오름차순: 앞쪽 = 익일시가가 크게 불리했던 건
const sum = (a) => a.reduce((s, v) => s + v, 0);
console.log(`\n=== 갭 손익 꼬리 집중도 (V1 − V2, 음수 = 익일시가가 불리) ===`);
console.log(`전체 합계 ${sum(g).toFixed(1)}%p (${g.length}건)`);
for (const k of [5, 10, 20, 40]) {
  const worst = g.slice(0, k);
  console.log(`  최악 ${String(k).padStart(2)}건 합계 ${sum(worst).toFixed(1).padStart(8)}%p = 전체의 ${(sum(worst) / sum(g) * 100).toFixed(0).padStart(4)}%  | 이들 제외한 평균 ${(sum(g.slice(k)) / (g.length - k) >= 0 ? '+' : '') + (sum(g.slice(k)) / (g.length - k)).toFixed(2)}%p`);
}
console.log(`최악 5건: ${g.slice(0, 5).map(v => v.toFixed(1) + '%p').join(' · ')}`);
console.log(`최고 5건: ${g.slice(-5).map(v => '+' + v.toFixed(1) + '%p').join(' · ')}`);
console.log(`\n※ 최악 몇 건이 전체의 대부분이면 → 갭은 드물지만 치명적인 꼬리 위험(MDD 유발). 회피가 맞다.`);
console.log(`※ 제외해도 평균이 음수로 남으면 → 갭 불리가 광범위. 역시 회피가 맞다.`);
