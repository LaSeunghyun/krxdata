/**
 * gap-axis.mjs — "장 30분 지나고 상황 보고 전략 고르기" 가설 검증 (2026-07-29 사용자 제안)
 *
 * ═══ 왜 이 축인가 ═══
 * 기존 시나리오(scenario-def.mjs)는 **전일까지의 데이터만** 쓴다(20일 수익률·20일 변동성 분위).
 * 사용자 제안: 장 시작 30분을 보고 당일 상황을 분류해 전략을 고르자 = **당일 정보 추가.**
 *
 * ═══ 갭을 대용으로 쓰는 근거 (실측) ═══
 * 005930 1분봉 83일: **갭 ↔ 30분수익률 상관 0.865** → 갭이 30분의 훌륭한 대용이다.
 *   그래서 1분봉(84~154일)이 아니라 **일봉 시가(868일)** 로 검증한다. 표본이 10배다.
 *   ※ 30분수익률 ↔ 이후 당일수익률 상관은 0.089 (방향 예측력 거의 없음).
 *     하지만 이 가설은 "방향 맞추기"가 아니라 "상태 분류 후 전략 선택"이므로 그것만으로 기각되지 않는다.
 *
 * ═══ 검증 규율 ═══
 * · 갭은 그날 **시가**에서 관측되므로 진입 결정 전에 알 수 있다 = lookahead 없음.
 * · 새 축을 **단독으로 먼저** 본다. 혼자서 차별력이 없으면 20 시나리오에 곱해도 희망 없다
 *   (일봉 868일로도 검증가능 시나리오가 6개였다 — 곱하면 표본이 말라버린다).
 * · IS(≤20240920)/OOS 분할 + 구성별 비교. 다중비교 건수 명시.
 *
 * 실행: node gap-axis.mjs   (내부에서 백테를 구성별로 실행하고 갭 축으로 재집계)
 */
import { createReadStream, readFileSync, unlinkSync, existsSync } from 'fs';
import readline from 'readline';
import { exec } from 'child_process';
import { promisify } from 'util';
const pexec = promisify(exec);

const BASE = '--strategies combo-v2 --live-parity --skipneutralrsi --slots 5 --tp1r 1 --tp2r 2 --liveuni 420 --no-freshness-check';
// 프론티어 양단 + 현행. trail은 청산폭, rsivol은 진입필터 — 오늘 프론티어를 만든 두 축이다.
const CONFIGS = [
  { key: 'base',    flags: '--trail 6 --rsivol 0' },                    // 현행(배포됨)
  { key: 'vol125',  flags: '--trail 6 --rsivol 1.25' },                 // 구 현행
  { key: 'trail4',  flags: '--trail 4 --rsivol 0' },                    // 타이트
  { key: 'trail10', flags: '--trail 10 --rsivol 0' },                   // 와이드
  { key: 'atrmax5', flags: '--trail 6 --rsivol 0 --rsiatrmax 5' },      // 저변동성 필터
  { key: 'stop5',   flags: '--trail 6 --rsivol 0 --stoppct 5' },        // 좁은 손절
];

// ── 시장 갭 계산 (005930) ────────────────────────────────────────────────────
let mkt = null;
await new Promise((res) => {
  const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
  rl.on('line', (l) => { if (l.slice(0, 30).includes('"005930"')) { try { mkt = JSON.parse(l); } catch {} } });
  rl.on('close', res);
});
const gapOf = new Map();
for (let i = 1; i < mkt.d.length; i++) gapOf.set(mkt.d[i], (mkt.o[i] / mkt.c[i - 1] - 1) * 100);

/** 갭 3구간. 경계는 결과 보기 전에 고정한다(순환논증 방지). ±0.5%는 한국시장 일상 갭 폭 기준. */
const GAP_BINS = [
  { key: 'G1', name: '갭하락', lo: -Infinity, hi: -0.5 },
  { key: 'G2', name: '보통', lo: -0.5, hi: 0.5 },
  { key: 'G3', name: '갭상승', lo: 0.5, hi: Infinity },
];
const gapBin = (day) => { const g = gapOf.get(day); if (g == null) return null; return GAP_BINS.find(b => g >= b.lo && g < b.hi)?.key ?? null; };

// ── 구성별 실행 → 갭축 재집계 ────────────────────────────────────────────────
const IS_END = '20240920';
const agg = {};   // config → gap → seg → {n, sum, win}
for (const cfg of CONFIGS) {
  const f = `gap-dump-${cfg.key}.json`;
  try {
    await pexec(`node backtest-swing.mjs ${BASE} ${cfg.flags} --scendump ${f}`, { cwd: 'C:\\claudeT\\files', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { console.error(`! ${cfg.key} 실행 실패: ${String(e.message).slice(0, 80)}`); continue; }
  if (!existsSync(f)) { console.error(`! ${cfg.key} 덤프 없음`); continue; }
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const trades = j.trades?.['combo-v2'] ?? [];
  // 포지션 단위 합산 (code + 진입일) — 부분익절 이중계산 방지
  const pos = new Map();
  for (const t of trades) {
    const ed = String(t.eday ?? t.day).replace(/-/g, '');
    const k = `${t.code}_${ed}`;
    let p = pos.get(k);
    if (!p) pos.set(k, p = { ed, pnl: 0 });
    p.pnl += Number(t.pnl) || 0;
  }
  agg[cfg.key] = {};
  for (const p of pos.values()) {
    const gb = gapBin(p.ed);
    if (!gb) continue;
    const seg = p.ed <= IS_END ? 'IS' : 'OOS';
    ((agg[cfg.key][gb] ??= {})[seg] ??= { n: 0, sum: 0, win: 0 });
    const a = agg[cfg.key][gb][seg];
    a.n++; a.sum += p.pnl; if (p.pnl > 0) a.win++;
  }
  try { unlinkSync(f); } catch {}
  process.stdout.write('.');
}
console.log('');

// ── 갭 구간 일수 ─────────────────────────────────────────────────────────────
const dayCnt = { G1: { IS: 0, OOS: 0 }, G2: { IS: 0, OOS: 0 }, G3: { IS: 0, OOS: 0 } };
for (const [d, g] of gapOf) {
  if (d < '20230102') continue;
  const b = GAP_BINS.find(x => g >= x.lo && g < x.hi)?.key;
  if (b) dayCnt[b][d <= IS_END ? 'IS' : 'OOS']++;
}
console.log('=== 갭 구간 거래일수 ===');
for (const b of GAP_BINS) console.log(`${b.key} ${b.name.padEnd(7)} IS ${String(dayCnt[b.key].IS).padStart(4)}일 · OOS ${String(dayCnt[b.key].OOS).padStart(4)}일`);

// ── 갭 × 구성 행렬 ───────────────────────────────────────────────────────────
console.log('\n=== 갭 × 구성: 포지션당 평균손익(원) / 포지션수 ===');
const hdr = CONFIGS.map(c => c.key.padStart(11)).join('');
console.log('구간 seg   ' + hdr);
for (const b of GAP_BINS) {
  for (const seg of ['IS', 'OOS']) {
    let line = `${b.key} ${seg.padEnd(4)}  `;
    for (const c of CONFIGS) {
      const a = agg[c.key]?.[b.key]?.[seg];
      line += a && a.n ? `${Math.round(a.sum / a.n).toLocaleString()}/${a.n}`.padStart(11) : '    -/-   '.padStart(11);
    }
    console.log(line);
  }
}

// ── 판정: 각 갭 구간에서 base를 IS·OOS 양쪽에서 이기는 구성이 있나 ─────────────
console.log('\n=== 판정: 갭 구간별로 base(현행)를 양쪽에서 이기는 구성 ===');
let nCmp = 0, nPass = 0;
for (const b of GAP_BINS) {
  const bi = agg.base?.[b.key];
  if (!bi?.IS?.n || !bi?.OOS?.n) { console.log(`${b.key} ${b.name}: base 표본 부족 → 판정 불가`); continue; }
  const bIS = bi.IS.sum / bi.IS.n, bOS = bi.OOS.sum / bi.OOS.n;
  const winners = [];
  for (const c of CONFIGS) {
    if (c.key === 'base') continue;
    const a = agg[c.key]?.[b.key];
    if (!a?.IS?.n || !a?.OOS?.n) continue;
    nCmp++;
    const aIS = a.IS.sum / a.IS.n, aOS = a.OOS.sum / a.OOS.n;
    if (aIS > bIS && aOS > bOS) { winners.push(`${c.key}(IS ${Math.round(aIS - bIS).toLocaleString()} · OOS ${Math.round(aOS - bOS).toLocaleString()})`); nPass++; }
  }
  console.log(`${b.key} ${b.name.padEnd(7)} base IS ${Math.round(bIS).toLocaleString()} / OOS ${Math.round(bOS).toLocaleString()}  →  ${winners.length ? '양쪽 초과: ' + winners.join(' · ') : '양쪽 초과 구성 없음'}`);
}
console.log(`\n비교 ${nCmp}건 중 양쪽 초과 ${nPass}건 · 우연 기대 ${(nCmp * 0.25).toFixed(1)}건 (양쪽 동시 초과 확률 대략 1/4)`);
console.log('※ 양쪽 초과가 우연 기대를 유의하게 넘지 못하면 갭 축은 차별력이 없다 → 20 시나리오에 곱할 근거 없음.');
console.log('※ 갭은 그날 시가에서 관측되므로 진입 전 알 수 있다(lookahead 없음).');
console.log('※ 갭 ↔ 30분수익률 상관 0.865(005930 83일) — 갭은 "30분 후 판단"의 대용이다.');
