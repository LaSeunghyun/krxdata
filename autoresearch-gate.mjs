// autoresearch 게이트 2종 — backtest-swing.mjs --dump 산출물만 입력으로 받는 순수 로직.
//
// ① 배선검증: 대상(combo-v2)이 실제로 바뀌었나. 안 바뀌면 not-wired.
//    근거 — non-live-parity 분기에 코드를 넣으면 --live-parity 실행에서 수치가 완전히 동일하게 나온다
//    (전례: backtest-swing.mjs:1551 ROTATE 죽은 코드, --caps A ≡ --caps G).
//    이를 discard 로 기록하면 시도조차 안 한 축이 기각축 표에 영구 등재돼 이후 탐색을 오염시킨다.
//    ※ 파라미터 무감도(밴드에 걸리는 체결이 0건)도 같은 증상을 낸다 — 둘 다 discard 가 아니다.
// ② 교차오염: combo-v2 는 레거시 combo 와 코드 분기를 공유하므로(k==='combo'||k==='combo-v2',
//    backtest-swing.mjs 1057·1067·1224·1848·1857행) 가드 없는 수정이 다른 전략 수치를 조용히 바꾼다.
//
// 지문은 stdout 을 파싱하지 않는다 — 에이전트가 출력 포맷을 건드리면 조용히 무너진다.

export const TARGET_STRATEGY = 'combo-v2';

// combo = 공유 분기 카나리아. swing-rank 는 daily_rankings DB 쿼리를 추가 유발하므로 제외.
export const GATE_STRATEGIES = Object.freeze(['combo', 'rsi2', 'hi120', 'gapfollow']);

export function fingerprintBook(book) {
  if (!book) return null;
  const daily = book.daily ?? [];
  return {
    trades: (book.trades ?? []).length,
    final: daily.length ? daily[daily.length - 1].equity : null,
    maxDD: book.maxDD ?? null,
  };
}

export function fingerprintDump(dump) {
  const books = dump?.books ?? {};
  const out = {};
  for (const key of Object.keys(books)) out[key] = fingerprintBook(books[key]);
  return out;
}

function sameFingerprint(a, b) {
  if (!a || !b) return false;
  return a.trades === b.trades && a.final === b.final && a.maxDD === b.maxDD;
}

/**
 * @returns {{status: 'ok'|'not-wired'|'contaminated'|'missing', missing: string[],
 *            changedGate: string[], targetChanged: boolean}}
 */
export function classifyGate(baseFp, candFp, { target = TARGET_STRATEGY, gate = GATE_STRATEGIES } = {}) {
  const missing = [];
  for (const key of [target, ...gate]) {
    if (!baseFp?.[key] || !candFp?.[key]) missing.push(key);
  }
  if (missing.length) return { status: 'missing', missing, changedGate: [], targetChanged: false };

  const changedGate = gate.filter(key => !sameFingerprint(baseFp[key], candFp[key]));
  const targetChanged = !sameFingerprint(baseFp[target], candFp[target]);

  // 오염된 런의 target 변화는 신뢰할 수 없으므로 오염이 배선검증을 이긴다.
  if (changedGate.length) return { status: 'contaminated', missing, changedGate, targetChanged };
  if (!targetChanged) return { status: 'not-wired', missing, changedGate, targetChanged };
  return { status: 'ok', missing, changedGate, targetChanged };
}

// 센서 생존 프로브 — 실제 base 지문의 게이트 전략 하나만 흔들어 게이트가 발화하는지 본다.
export function perturbFingerprint(baseFp, strategy) {
  const target = baseFp?.[strategy];
  if (!target) throw new Error(`perturbFingerprint: 지문에 ${strategy} 가 없다`);
  return { ...baseFp, [strategy]: { ...target, trades: target.trades + 1 } };
}
