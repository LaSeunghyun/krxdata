/**
 * ai-judge.mjs — 신호 스냅샷 → AI 매수판단(thesis·종목별전략·확신도). SHADOW 전용(실주문 없음).
 *
 * 역할: 다중신호(공시 세부내용·펀더·모멘텀·거래량·수급) + 사전 수집 뉴스 스니펫을 종합해
 *   매수/스킵 결정 + 매수사유 + 종목별 매매전략(목표·손절·thesis깨짐조건·보유예상)을 쓴다.
 * 정직 제약: 제공된 신호·검색결과 밖 숫자 창작 금지. 근거 없으면 skip. 급등 양봉 추격 금지(사용자·검증 모두 반대).
 *   이 판단은 미검증 = shadow 원장에 기록·추적만. 실계좌는 검증(shadow 성과) 후 승격.
 */
import { callClaude, parseLlmJson } from './forecast-llm.mjs';

export function buildJudgePrompt(sig) {
  return `당신은 한국 주식 스윙 트레이더다. 아래 한 종목의 다중신호를 종합해 매수 여부를 판단한다.
뉴스는 신호 데이터의 news 배열에 제공된 제목·출처·스니펫만 사용한다. 제공된 뉴스 밖 검색이나 추정은 금지한다.

핵심 원칙(엄수):
1. 근거 기반. 제공된 신호와 제공된 뉴스만 사용. 숫자·사실 창작 금지. 모르면 "확인 불가".
2. 촉매(공시) 세부내용을 반드시 읽어라 — 타이틀 말고 규모/방향(무상 배정비율·유상 방식과 규모·계약금액과 매출대비%·실적 YoY·순매수 규모).
3. 급등 양봉 추격 금지. 거래량은 촉매의 "확인"으로만 본다(대량거래=관심 증가). 거래량만으로 사지 않는다.
4. 확신 낮거나 촉매 불명확하면 decision="skip". 억지 매수 금지.
5. 애널리스트(analyst) 해석 규칙 — 참고자료일 뿐 매수근거 단독 사용 금지:
   - upsidePct(컨센서스 목표가 대비 상승여력)는 **목표가 갱신 지연(stale) 가능성**을 반드시 감안한다. 하락장에서
     애널리스트 목표가는 늦게 내려오므로 "상승여력 +50%"가 기회가 아니라 미갱신 신호일 수 있다. latestDate로 신선도를 확인하라.
   - 매수의견 비율(buyRatio)은 한국 시장 특성상 구조적으로 높다(매도의견 희소) → 높다고 강세신호 아님.
   - 실제 정보가치가 있는 건 **변화**다: upgrades/downgrades(직전의견 대비 상하향), 목표가 방향, 신규 커버리지 개시.
   - covered=false(커버리지 없음)는 악재가 아니라 "기관 검증 부족한 소형주" 특성으로만 해석하고, opposing에 명시하라.
6. 매수 시 종목별 전략을 구체 수치로: 목표수익률·손절%·예상보유일·"이러면 논리 깨짐"(thesis_break) 조건.
   목표수익률은 애널리스트 목표가를 그대로 베끼지 말고 촉매·기간에 맞게 스스로 정한다.
7. 출력은 아래 JSON 하나만. 코드펜스·다른 텍스트 금지.

출력 형식:
{"decision":"buy"|"skip",
 "conviction":1|2|3|4|5,
 "catalyst":"<핵심 촉매 한 줄(이벤트타입·규모 또는 뉴스). 없으면 '뚜렷한 촉매 없음'>",
 "thesis":["<매수사유 불릿, 각 줄 근거 신호 명시, 최대 3줄>"],
 "strategy":{"target_pct":<숫자>,"stop_pct":<숫자>,"horizon_days":<숫자>,"thesis_break":["<논리 깨짐 조건>"]},
 "supporting":["<매수를 지지하는 신호>"],
 "opposing":["<반대/리스크 신호>"],
 "news_check":"<제공된 뉴스 요지 또는 '뉴스 없음/확인 불가'>",
 "analyst_check":"<애널리스트 커버리지 요지: 커버 증권사수·컨센서스목표가·최근 상하향 여부와 신선도 판단. 미커버면 '커버리지 없음'>"}

신호 데이터:
${JSON.stringify(sig, null, 1)}`;
}

const clampInt = (x, lo, hi, d) => { const n = Math.round(Number(x)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const arr = (x, n = 5) => Array.isArray(x) ? x.filter(s => typeof s === 'string').slice(0, n) : [];

export function sanitizeDecision(parsed) {
  if (!parsed || (parsed.decision !== 'buy' && parsed.decision !== 'skip')) return null;
  const s = parsed.strategy || {};
  return {
    decision: parsed.decision,
    conviction: clampInt(parsed.conviction, 1, 5, 1),
    catalyst: typeof parsed.catalyst === 'string' ? parsed.catalyst.slice(0, 200) : '확인 불가',
    thesis: arr(parsed.thesis, 3),
    strategy: parsed.decision === 'buy' ? {
      target_pct: clampInt(s.target_pct, 1, 100, 10),
      stop_pct: clampInt(s.stop_pct, 1, 50, 7),
      horizon_days: clampInt(s.horizon_days, 1, 120, 10),
      thesis_break: arr(s.thesis_break, 4),
    } : null,
    supporting: arr(parsed.supporting), opposing: arr(parsed.opposing),
    news_check: typeof parsed.news_check === 'string' ? parsed.news_check.slice(0, 300) : null,
    analyst_check: typeof parsed.analyst_check === 'string' ? parsed.analyst_check.slice(0, 300) : null,
  };
}

/** 신호 스냅샷 → 판단. 실패 시 null(판단 못하면 매수 안 함 = 안전). */
export function judgeCandidate(sig, { invoke, allowWebSearch = false } = {}) {
  const call = invoke ?? callClaude;
  const extraArgs = allowWebSearch ? ['--allowedTools', 'WebSearch'] : [];
  const parsed = parseLlmJson(call(buildJudgePrompt(sig), { extraArgs, timeoutMs: 300_000 }));
  return sanitizeDecision(parsed);
}
