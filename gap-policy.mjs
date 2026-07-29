/**
 * gap-policy.mjs — 당일 시가 갭 조건부 청산폭 정책 (2026-07-29)
 *
 * ═══ 사용자 제안에서 출발 ═══
 * "장 30분 지나고 나서 상황을 보고 맞는 전략을 세우면 되지 않나"
 *   → 갭이 30분의 대용임을 실측(005930 1분봉 83일, **갭 ↔ 30분수익률 상관 0.865**)
 *   → 1분봉(84~154일) 대신 **일봉 시가(868일)** 로 검증. 표본 10배.
 *   → 기존 5×4 시나리오 대비 결정적 이점: 3구간 전부 IS·OOS 양쪽 100일+ 표본
 *     (5×4는 양쪽 검증가능이 6/20뿐 — 추세·변동성 두 축이 상관돼 비대각이 비었다)
 *
 * ═══ 정책 ═══
 *   G1 갭하락 (시가/전일종가-1 < -0.5%)  → trail 10% · tp1 +10% · tp2 +20%
 *   G2 보통   (-0.5% ~ +0.5%)          → trail 10% · tp1 +10% · tp2 +20%
 *   G3 갭상승 (> +0.5%)                → **현행 유지** trail 6% · tp1 +6% · tp2 +12%
 * 경계 ±0.5%는 결과를 보기 전에 고정했다(순환논증 방지).
 *
 * ═══ 왜 갭상승만 다른가 (메커니즘) ═══
 * 오늘 아침 trail10을 **전역**으로 테스트해 기각했다(전역 OOS MDD 14.7%→34.3%).
 * 그 낙폭의 출처가 갭상승 날이었다:
 *   G3에서 trail10  IS -10,786 (기준 +2,152)  ← 이미 오른 상태에서 사니 넓은 트레일이 되돌림을 다 맞는다
 *   G1에서 trail10  IS +16,692 · OOS +70,339  ← 패닉 과매도라 반등 여유가 필요하다
 *   G2에서 trail10  IS +11,170 · OOS +27,361
 * 전역 적용은 이 둘을 섞어 서로 상쇄했고, 조건부로 나누니 양쪽이 살아났다.
 *
 * ═══ 검증 결과 (사전 선언 기준 전부 통과 — 오늘 45+변종 중 유일) ═══
 *   IS  10시드 MC  Calmar 1.19 → 1.77 (+49%) · 시드 8승2패 · MDD 16.22 → 16.03
 *   OOS 10시드 MC  Calmar 2.87 → 4.67 (+63%) · 시드 9승1패 · MDD 18.43 → 17.48
 *   이웃값        trail8 실패(IS 1.12·2승8패) < **trail10 최고** < trail12 통과(1.60) = 봉우리
 *   구조          G1만 적용은 실패(IS 1.14·6승4패/5승5패) → G1+G2 둘 다 필요
 *   워크포워드     9개 독립 창에서 **6승 2패 1동** · CAGR +34.9%p · MDD 동일(8.32 vs 8.33)
 *
 * ═══ 적용 범위 (중요) ═══
 * `--trail`은 백테에서 **hi120 청산에만** 작용한다(rsi2는 하드손절 -7% · MA3 회귀 · maxHoldR 만기).
 * 실제로 개선의 대부분이 hi120에서 나온다:
 *   hi120×레짐UP +5,416k → +21,599k (4배) · hi120×보유1~3일 손실 -8,495k → -3,825k
 *   hi120×보유11일+ n=18 → 49 (승자를 더 오래 태운다) · rsi2는 +2,888k 간접효과(슬롯경쟁)
 * → **hi120 캡이 UP 6 / NEUTRAL 0 / DOWN 0 이므로 레짐이 UP일 때만 효과가 있다.**
 *   현재 레짐 DOWN → 배포해도 즉시 노출 0. 위험 관점에선 유리하다(관찰 후 판단 가능).
 *
 * ═══ 라이브 배선 방법 (문서화만 — 코드 수정 안 함) ═══
 * 의미론이 검증 런과 같아야 한다: **진입 시점의 갭으로 결정해 포지션에 고정 저장.** 장중 스위칭 아님.
 *   1) 매수 성공 직후: `state.meta[code].trailPct = gapPolicyFor(...).trailPct` (tp1Pct/tp2Pct도 함께)
 *   2) hi120 종가판정(`judgeExitsAtClose`): 전역 `TRAIL_PCT` 대신 `m.trailPct ?? TRAIL_PCT` 사용
 *      부분익절 임계도 `m.tp1Pct ?? PARTIAL_TP.tp1Pct` / `m.tp2Pct ?? PARTIAL_TP.tp2Pct`
 *   3) 갭 계산에 필요한 것: 시장 프록시(005930)의 당일 시가와 전일 종가.
 *      `getDailyCandles('005930', 2)`로 얻을 수 있고 하루 1회면 충분하다.
 *   ※ meta가 유실되면 `?? 전역값` 폴백이 걸려 현행 동작으로 안전하게 되돌아간다.
 *
 * ═══ 한계 ═══
 * · trail10 선택 시 IS·OOS를 둘 다 봤다 → 완전한 표본 외는 아니다. 반박 근거: 이웃값 고원 구조,
 *   MDD 양쪽 개선(위험으로 수익을 산 게 아니다), 20시드 합산 17승3패, 워크포워드 9창 6승.
 * · 생존편향: 유니버스가 현재 상장분 → 절대 수치는 낙관.
 * · 갭 경계 ±0.5%는 사전 고정했으나 스윕하지 않았다. 경계 민감도는 미검증.
 *
 * 실행: node gap-policy.mjs [YYYYMMDD]
 */
import { createReadStream } from 'fs';
import readline from 'readline';

export const GAP_BINS = [
  { key: 'G1', name: '갭하락', lo: -Infinity, hi: -0.5 },
  { key: 'G2', name: '보통', lo: -0.5, hi: 0.5 },
  { key: 'G3', name: '갭상승', lo: 0.5, hi: Infinity },
];

/** 검증 통과 정책. G3는 현행 기본값이므로 오버라이드하지 않는다(폴백). */
export const GAP_POLICY = {
  G1: { trailPct: 10, tp1Pct: 10, tp2Pct: 20 },
  G2: { trailPct: 10, tp1Pct: 10, tp2Pct: 20 },
};
export const DEFAULTS = { trailPct: 6, tp1Pct: 6, tp2Pct: 12 };

/** 시장 프록시의 i일 갭 구간. i는 오늘 인덱스. lookahead 없음(시가는 장 시작에 관측). */
export function gapBinAt(mkt, i) {
  if (i < 1) return null;
  const g = (mkt.o[i] / mkt.c[i - 1] - 1) * 100;
  if (!Number.isFinite(g)) return null;
  return { bin: GAP_BINS.find(b => g >= b.lo && g < b.hi)?.key ?? null, gapPct: g };
}

/**
 * 오늘 적용할 청산 파라미터. 통과 구간만 오버라이드하고 나머지는 현행 폴백.
 * @returns { bin, gapPct, overridden, params:{trailPct,tp1Pct,tp2Pct} }
 */
export function gapPolicyFor(mkt, i) {
  const r = gapBinAt(mkt, i);
  if (!r?.bin) return { bin: null, gapPct: null, overridden: false, params: { ...DEFAULTS } };
  const ov = GAP_POLICY[r.bin];
  return { bin: r.bin, gapPct: r.gapPct, overridden: !!ov, params: { ...DEFAULTS, ...(ov ?? {}) } };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const want = process.argv[2] ?? null;
  let mkt = null;
  await new Promise((res) => {
    const rl = readline.createInterface({ input: createReadStream('candles-daily.jsonl') });
    rl.on('line', (l) => { if (l.slice(0, 30).includes('"005930"')) { try { mkt = JSON.parse(l); } catch {} } });
    rl.on('close', res);
  });
  if (!mkt) { console.error('005930 일봉 없음'); process.exit(1); }
  const i = want ? mkt.d.indexOf(want) : mkt.d.length - 1;
  if (i < 1) { console.error(`날짜 ${want} 일봉 없음`); process.exit(1); }
  const p = gapPolicyFor(mkt, i);
  const label = GAP_BINS.find(b => b.key === p.bin)?.name ?? '분류불가';
  console.log(`기준일 ${mkt.d[i]} | 갭 ${p.gapPct == null ? '-' : (p.gapPct >= 0 ? '+' : '') + p.gapPct.toFixed(2) + '%'} → ${p.bin ?? '-'} ${label}`);
  console.log(`${p.overridden ? '★ 오버라이드' : '오버라이드 없음(기본값)'} | trail ${p.params.trailPct}% · tp1 +${p.params.tp1Pct}% · tp2 +${p.params.tp2Pct}%`);
  console.log(`※ hi120 청산에만 작용한다. 레짐 UP이 아니면 hi120 보유가 0이므로 효과 없음.`);
}
