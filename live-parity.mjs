const REGIME_RSI_FACTOR = Object.freeze({ UP: 1, NEUTRAL: 0.85, DOWN: 0.5 });

export function buildLiveCandidates(rows, {
  regime,
  rsiMax = 10,
  minBreakout = 3,
  allowUpRsi = true,
  rsiVolMin = 0,    // rsi2 확인필터: 거래량비(당일/20일평균) ≥ 이 값 (투매 확인). 0=off
  closeLocMin = 0,  // rsi2 확인필터: 종가위치((c-l)/(h-l)) ≥ 이 값 (강한 마감). 0=off
  volSurge = null,  // 거래량급증 진입 sub {volMin,dayRetMin,closeLocMin}. null=off(라이브 기본 — 검증 전까지 동작 불변). DOWN 레짐 제외.
  regimeOf = null,  // 2026-07-27 검증용: 종목별 레짐 함수 (row → 'UP'|'NEUTRAL'|'DOWN'). null=시장 프록시 단일 레짐(현행 라이브).
  /**
   * hi120(돌파) 진입을 허용할 레짐. ★ 2026-08-04 신설 · **기본값은 현행과 완전히 동일**(UP 전용).
   *
   * 왜 파라미터가 필요했나: DOWN·NEUTRAL 의 hi120 차단이 **두 겹**이었다 —
   *   ① 캡 테이블(CAPS_PRESETS) 의 `DOWN: { hi120: 0 }`
   *   ② 여기 `reg === 'UP'` 하드 게이트 (후보를 아예 **생성하지 않는다**)
   * ②가 있으면 캡만 바꿔도 아무 효과가 없다 — 08-04 실측에서 `--caps A` 와 `--caps G` 가
   * 체결 1190·CAGR 42.4%·MDD 25.1% 까지 **완전히 동일**하게 나왔다. 그 상태로 60시드를 돌렸다면
   * "차이 없음 = 노이즈 내" 라는 **거짓 음성**을 얻고 축을 잘못 종결했을 것이다.
   *
   * 이 파일은 라이브 봇(stock-live.mjs)도 import 한다 → 기본값을 바꾸면 실계좌 동작이 바뀐다.
   * 그래서 기본은 ['UP'] 로 고정하고 백테만 --brkreg 로 넓힌다.
   * ※ 라이브 이식 시에는 stock-live.mjs 쪽 `if (regime === 'UP')` 블록(돌파 계산 자체를 건너뛴다)도
   *   함께 열어야 한다 — 거기서도 breakoutPct 가 만들어지지 않으므로 이 파라미터만으론 부족하다.
   */
  breakRegimes = ['UP'],
} = {}) {
  const brkOk = new Set(breakRegimes);
  const candidates = [];
  for (const row of rows) {
    const reg = regimeOf ? (regimeOf(row) ?? regime) : regime;
    const volOk = !rsiVolMin || Number(row.volRatio ?? 1) >= rsiVolMin;
    const clOk = !closeLocMin || Number(row.closeLoc ?? 1) >= closeLocMin;
    if (Number(row.rsi) < rsiMax && (reg !== 'UP' || allowUpRsi) && volOk && clOk) {
      candidates.push({
        ...row,
        sub: 'rsi2',
        conviction: (rsiMax - Number(row.rsi)) * (REGIME_RSI_FACTOR[reg] ?? 0.85),
      });
    }
    if (brkOk.has(reg) && Number(row.breakoutPct) >= minBreakout) {
      candidates.push({
        ...row,
        sub: 'hi120',
        conviction: Math.min(10, Number(row.breakoutPct)),
      });
    }
    // 거래량급증 진입: 대량거래(volRatio)+양봉(dayRet)+강한마감(closeLoc)이 동반된 모멘텀. 촉매(공시/뉴스)는 대개 거래량으로 먼저 드러남.
    if (volSurge && reg !== 'DOWN'
      && Number(row.volRatio ?? 0) >= volSurge.volMin
      && Number(row.dayRet ?? -1e9) >= (volSurge.dayRetMin ?? 0)
      && Number(row.closeLoc ?? 0) >= (volSurge.closeLocMin ?? 0)) {
      candidates.push({
        ...row,
        sub: 'volsurge',
        conviction: Math.min(10, Number(row.volRatio) * 2) * (REGIME_RSI_FACTOR[reg] ?? 0.85),
      });
    }
  }
  candidates.sort((a, b) => {
    const convictionOrder = b.conviction - a.conviction;
    if (convictionOrder) return convictionOrder;
    if (a.sub === b.sub) return 0;
    return a.sub === 'hi120' ? -1 : 1;
  });
  return candidates;
}

/**
 * ★ 2026-08-04 신설 — 레짐별 sub 동시보유 캡(LIVE_COMBO_CAPS) 집행.
 *
 * 왜 새로 만드나: **라이브(stock-live.mjs)에 이 규칙이 아예 없었다.** `LIVE_COMBO_CAPS` 참조가 0건이고
 * 유일한 진입 게이트가 `bigCount < LIVE_SLOTS` 였다. 백테는 매 후보마다
 * `if (countSub(candidate.sub) >= caps[sub]) continue` (backtest-swing.mjs:1463) 로 막는다.
 *   → DOWN 레짐 검증본 = rsi2 4 + 1슬롯 현금. 라이브 = rsi2 5(만석).
 *   실측 위반: 2026-08-03 09:05~09:14 레짐 DOWN 에서 rsi2 3건을 연속 매수해
 *   `분산 1/3 → 1/2 → 1/1` 로 슬롯을 끝까지 채웠다. 하락장 노출이 검증본보다 25% 크다.
 *
 * 백테와의 의미 일치 지점 3가지:
 *  ① 세는 대상은 **현재 보유 포지션의 sub** 다(후보가 아니라). 백테 countSub 와 동일.
 *  ② 캡 테이블에 없는 sub 은 미적용(백테의 volsurge 가 VOLSURGE_CAP 로 따로 처리되는 것과 같다).
 *     라이브는 volsurge 가 off(volSurge=null)라 현재 해당 없음.
 *  ③ 백테는 후보를 순회하며 매수할 때마다 countSub 이 증가하지만, 라이브는 **사이클당 매수 1건**
 *     (stock-live.mjs 의 `break`)이고 다음 사이클에 보유를 재조회한다 → 고정 counts 로 필터해도 결과가 같다.
 *
 * regime 이 caps 테이블에 없으면(스캔 전 null 등) 막지 않는다 — 그 상태에선 후보 자체가 비어 있다.
 *
 * @param {Array} candidates  buildLiveCandidates 결과(정렬 완료)
 * @param {string} regime     'UP' | 'NEUTRAL' | 'DOWN'
 * @param {string[]} heldSubs 현재 보유 포지션의 sub 목록. sub 미상(수동·레거시)은 호출부에서 제외한다
 *                            — 백테에는 sub 없는 포지션이 존재하지 않으므로 어느 캡에도 넣지 않는 것이 맞다
 *                            (그 포지션은 LIVE_SLOTS 게이트가 이미 제한한다).
 * @param {object} caps       LIVE_COMBO_CAPS
 * @returns {{kept: Array, blocked: Array}}
 */
export function applyComboCaps(candidates, { regime, heldSubs = [], caps = {} } = {}) {
  const cap = caps[regime] ?? null;
  if (!cap) return { kept: candidates ?? [], blocked: [] };
  const counts = {};
  for (const s of heldSubs) if (s) counts[s] = (counts[s] ?? 0) + 1;
  const kept = [], blocked = [];
  for (const c of candidates ?? []) {
    const lim = cap[c.sub];
    if (lim != null && (counts[c.sub] ?? 0) >= lim) blocked.push(c);
    else kept.push(c);
  }
  return { kept, blocked };
}

export function liveCandidateBudget({
  cash,
  equity,
  slots,
  conviction,
  strongThreshold,
  strongFraction,
  exposureMultiplier = 1,
}) {
  const perSlot = Math.floor(equity / slots);
  const baseBudget = conviction >= strongThreshold ? Math.floor(cash * strongFraction) : Math.min(cash, perSlot);
  const multiplier = Math.max(0, Math.min(1, Number(exposureMultiplier) || 0));
  return Math.floor(baseBudget * multiplier);
}
