/**
 * research-exit-timing.mjs — 2026-07-30
 *
 * 질문(사용자): "하루 1회 매도로는 15% 룰에서도 NXT장에서 계속 떨어져 -20% 가 되는 걸 대응 못 한다."
 *   현행 = 15:35 종가판정 → **익일 08:00(NXT 프리마켓)** 집행 (stock-live.mjs:690 `m.exitDay !== today` 가드).
 *   후보 = 판정 당일 NXT 애프터마켓(16:00~20:00)에 바로 집행.
 *
 * 이건 전략이 아니라 **집행 시각** 문제라 포트폴리오 시뮬이 필요 없다. 조건부 가격경로만 재면 된다.
 *   측정값 Δ = (해당 시각 가격 / 15:30 종가 - 1) · % — 판정에 쓴 가격 대비 실제 체결 수준.
 *   Δ가 클수록 좋은 청산(더 높은 값에 판다).
 *
 * 데이터: data-1m/*.jsonl (토스 1분봉 백필, 234종목). **08:00~20:00 = NXT 포함**을 실측 확인했다
 *   (009150: 08시 4,897봉 · 16~19시 각 5,040봉 · 20시 83봉 / 84거래일 2026-03-25~07-27).
 *   → 이 질문에 답할 데이터가 이미 있다. KIS 는 당일만 주므로 불가능하다.
 *
 * 조건(판정 발동 대용): 진입일 e ∈ {d-4..d} 의 종가를 진입가로 보고 close[d] <= entry×(1-stop%) 이면
 *   그 종목-일에 손절 판정이 섰다고 본다. maxHoldR=5 를 모사한 것이고, **라이브 진입은 장중이라 근사**다.
 *
 * ⚠️ 오염 가드: 분봉·일봉 수정주가 불일치가 평균 부호를 뒤집은 선례가 있다(2026-07-29, commit d07619f).
 *   |20:00/15:30 - 1| > 30% 인 종목-일은 가짜 점프로 보고 제외하고 건수를 보고한다.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = 'data-1m';
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const STOP = Number(argOf('--stop', 15));       // 하드손절 % (현행 라이브 15)
const MAXHOLD = Number(argOf('--hold', 5));     // 진입 후보 소급 일수 (maxHoldR)
const LIMIT = Number(argOf('--max', 0));        // 종목 수 제한(0=전부)

// 재는 시각 — 같은 날(KRX 마감 후 NXT) vs 익일
const SAME = [['15:40', 1540], ['16:00', 1600], ['17:00', 1700], ['19:00', 1900], ['19:50', 1950]];
const NEXT = [['익일08:00', 800], ['익일08:30', 830], ['익일09:05', 905], ['익일09:30', 930]];

const hhmmOf = (epochSec) => { const d = new Date(epochSec * 1000 + 9 * 3600_000); return d.getUTCHours() * 100 + d.getUTCMinutes(); };
const dayOf = (epochSec) => { const d = new Date(epochSec * 1000 + 9 * 3600_000); return d.toISOString().slice(0, 10); };

// 판정용 "그 시각 시점의 가격" = 그 시각 **이하** 마지막 봉 종가
function priceAt(bars, target) {
  let v = null;
  for (const b of bars) { if (b.hm <= target) v = b.c; else break; }
  return v;
}
/**
 * 집행용 "그 시각에 주문을 내면 받는 가격" = 그 시각 **이상** 첫 봉 종가.
 * ★ 이게 priceAt 과 다르다. 처음엔 집행에도 priceAt 을 써서 `익일08:00` 이 전부 null 이 됐다
 *   (08:00 정각 봉이 드물다 — 시간 08시 봉은 하루 약 58개로 08:01~ 부터다).
 *   주문은 개장 전 가격으로 체결될 수 없으므로 집행은 반드시 at-or-after 여야 한다.
 */
function priceAtOrAfter(bars, target) {
  for (const b of bars) if (b.hm >= target) return b.c;
  return null;
}

const files = readdirSync(DIR).filter(f => f.endsWith('.jsonl'));
const use = LIMIT > 0 ? files.slice(0, LIMIT) : files;
console.log(`=== 예약청산 집행 시각 측정 (손절 -${STOP}% · 진입소급 ${MAXHOLD}일) ===`);
console.log(`종목 ${use.length} · data-1m\n`);

const acc = new Map();           // label -> [Δ%...]
const push = (k, v) => { if (!acc.has(k)) acc.set(k, []); acc.get(k).push(v); };
let events = 0, dropped = 0, stockDays = 0, stocks = 0;

for (const f of use) {
  let o;
  try { o = JSON.parse(readFileSync(join(DIR, f), 'utf8').trim().split('\n')[0]); } catch { continue; }
  const { t, c } = o; if (!t || !c || t.length < 500) continue;
  stocks++;

  // 일자별 봉 묶기
  const byDay = new Map();
  for (let k = 0; k < t.length; k++) {
    const d = dayOf(t[k]);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({ hm: hhmmOf(t[k]), c: c[k] });
  }
  const days = [...byDay.keys()].sort();
  for (const d of days) byDay.get(d).sort((a, b) => a.hm - b.hm);

  // 일별 KRX 종가(15:30 이하 마지막 봉) — 판정에 쓰는 값
  const krxClose = new Map();
  for (const d of days) { const p = priceAt(byDay.get(d), 1530); if (p > 0) krxClose.set(d, p); }

  for (let di = MAXHOLD; di < days.length - 1; di++) {
    const d = days[di], dn = days[di + 1];
    const cl = krxClose.get(d); if (!(cl > 0)) continue;
    stockDays++;

    // 오염 가드
    const c20 = priceAt(byDay.get(d), 2000);
    if (c20 > 0 && Math.abs(c20 / cl - 1) > 0.30) { dropped++; continue; }

    // 손절 판정이 서는가: 최근 MAXHOLD일 종가 중 하나를 진입가로 봤을 때 -STOP% 이하
    let fired = false;
    for (let k = 1; k <= MAXHOLD; k++) {
      const e = krxClose.get(days[di - k]);
      if (e > 0 && cl <= e * (1 - STOP / 100)) { fired = true; break; }
    }
    if (!fired) continue;
    events++;

    for (const [lab, hm] of SAME) { const p = priceAtOrAfter(byDay.get(d), hm); if (p > 0) push(lab, (p / cl - 1) * 100); }
    for (const [lab, hm] of NEXT) { const p = priceAtOrAfter(byDay.get(dn), hm); if (p > 0) push(lab, (p / cl - 1) * 100); }
  }
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * q)] : 0; };

console.log(`종목 ${stocks} · 종목-일 ${stockDays.toLocaleString()} · **손절판정 발동 ${events.toLocaleString()}건** · 오염제외 ${dropped}건\n`);
if (!events) { console.log('발동 0건 — 조건이나 데이터를 확인할 것.'); process.exit(1); }

console.log('집행시각        n      평균Δ     중앙Δ    최악5%    최선5%   개선비율');
console.log('─'.repeat(76));
const base = acc.get('익일08:00') ?? [];
for (const [lab] of [...SAME, ...NEXT]) {
  const a = acc.get(lab) ?? []; if (!a.length) continue;
  const better = base.length ? '' : '';
  console.log(`${lab.padEnd(12)} ${String(a.length).padStart(6)} ${avg(a).toFixed(2).padStart(9)}% ${med(a).toFixed(2).padStart(8)}% ${pct(a, 0.05).toFixed(2).padStart(8)}% ${pct(a, 0.95).toFixed(2).padStart(8)}% ${(a.filter(v => v > 0).length / a.length * 100).toFixed(1).padStart(8)}%${better}`);
}
console.log('\n※ Δ = 그 시각 가격 / 15:30 종가 - 1. 양수면 판정가보다 높게 팔린다.');
console.log('※ "개선비율" = Δ>0 인 비율.');

// 현행(익일 08:00) 대비 쌍대비교 — 같은 이벤트에서만 비교해야 한다
console.log('\n=== 현행(익일 08:00) 대비 쌍대비교 ===');
console.log('후보시각        쌍n    평균차이   중앙차이   후보승   무승부');
console.log('─'.repeat(70));
// 쌍을 맞추려면 이벤트별로 두 값을 같이 들고 있어야 한다 → 재수집
const pairAcc = new Map();
{
  let ev = 0;
  for (const f of use) {
    let o; try { o = JSON.parse(readFileSync(join(DIR, f), 'utf8').trim().split('\n')[0]); } catch { continue; }
    const { t, c } = o; if (!t || !c || t.length < 500) continue;
    const byDay = new Map();
    for (let k = 0; k < t.length; k++) { const d = dayOf(t[k]); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push({ hm: hhmmOf(t[k]), c: c[k] }); }
    const days = [...byDay.keys()].sort();
    for (const d of days) byDay.get(d).sort((a, b) => a.hm - b.hm);
    const krxClose = new Map();
    for (const d of days) { const p = priceAt(byDay.get(d), 1530); if (p > 0) krxClose.set(d, p); }
    for (let di = MAXHOLD; di < days.length - 1; di++) {
      const d = days[di], dn = days[di + 1];
      const cl = krxClose.get(d); if (!(cl > 0)) continue;
      const c20 = priceAt(byDay.get(d), 2000);
      if (c20 > 0 && Math.abs(c20 / cl - 1) > 0.30) continue;
      let fired = false;
      for (let k = 1; k <= MAXHOLD; k++) { const e = krxClose.get(days[di - k]); if (e > 0 && cl <= e * (1 - STOP / 100)) { fired = true; break; } }
      if (!fired) continue;
      const nx = priceAtOrAfter(byDay.get(dn), 800); if (!(nx > 0)) continue;
      ev++;
      for (const [lab, hm] of SAME) {
        const p = priceAtOrAfter(byDay.get(d), hm); if (!(p > 0)) continue;
        if (!pairAcc.has(lab)) pairAcc.set(lab, []);
        pairAcc.get(lab).push((p / nx - 1) * 100);      // 후보 - 현행
      }
    }
  }
}
for (const [lab] of SAME) {
  const a = pairAcc.get(lab) ?? []; if (!a.length) continue;
  const w = a.filter(v => v > 1e-9).length, tie = a.filter(v => Math.abs(v) <= 1e-9).length;
  console.log(`${lab.padEnd(12)} ${String(a.length).padStart(6)} ${avg(a).toFixed(2).padStart(9)}% ${med(a).toFixed(2).padStart(9)}% ${(w / a.length * 100).toFixed(1).padStart(7)}% ${(tie / a.length * 100).toFixed(1).padStart(7)}%`);
}
console.log('\n※ 양수면 그 시각에 파는 게 익일 08:00보다 높게 팔린다는 뜻(같은 이벤트 쌍대비교).');
