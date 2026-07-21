/**
 * forecast-llm.mjs — 예측 채점 결론 시점의 LLM 세부 분석 (Phase 1.5)
 *
 * 역할 제한 (설계 §5): LLM은 숫자를 만들지 않는다. 채점이 끝난 결과에 대해
 *  - 오차 원인을 13개 고정 범주에서 분류하고 확실성 3등급(확인됨/개연성 있음/확인 불가)을 매긴다
 *  - 사람이 읽는 세부 분석 내러티브를 쓴다
 * 뉴스·수급 데이터는 입력에 없으므로 그런 원인은 "확인 불가"로만 분류 가능하다(사후 스토리텔링 방지).
 * 호출 실패는 보고를 막지 않는다(분석 없이 발송) — LLM 장애가 결측을 만들지 않는다.
 *
 * 실행: 로컬 claude CLI 헤드리스(`claude -p`). 비활성화: FORECAST_LLM=0
 */
import { spawnSync } from 'child_process';

export const ERROR_CATEGORIES = [
  '데이터 지연 또는 누락', '예상하지 못한 공시·뉴스', '해외시장 또는 환율 급반전',
  '외국인·기관 수급 전환', '프로그램매매 급변', '개별 대형주의 지수 영향',
  '장 시작·종가 단일가 효과', 'NXT와 KRX 간 유동성 분산', '섹터 구성 또는 분류 문제',
  '변동성 과소평가', '방향은 맞았으나 강도 과대·과소평가', '인과관계 오판', '확인 불가',
];
const CERTAINTY = ['확인됨', '개연성 있음', '확인 불가'];

export function buildVerificationPrompt(payload) {
  return `당신은 한국 주식시장 단기 확률예측 시스템의 사후검증 분석가다.
아래는 방금 채점이 끝난 예측(원장)과 실제 결과다. 세부 분석을 작성하라.

규칙 (엄수):
1. 오차 원인은 다음 범주에서만 선택: ${JSON.stringify(ERROR_CATEGORIES)}
2. 확실성 등급: "확인됨"은 아래 제공된 수치만으로 직접 입증되는 것만(예: |실제|>σ면 변동성 과소평가,
   방향 적중+큰 오차면 강도 과대·과소평가). 뉴스·공시·수급·해외시장 데이터는 이 입력에 없다 —
   그런 원인을 쓰려면 반드시 "확인 불가"로 표시한다. 정황 추론은 "개연성 있음".
3. 결과에 맞춘 그럴듯한 사후 스토리텔링 금지. 모르면 "확인 불가"라고 쓴다.
4. 적중(direction_hit=true이고 in_range=true이고 partial_hit=false)한 행은 error_cause를 null로 둔다.
5. 매수·매도 추천, 종목 추천 금지.
6. 출력은 아래 JSON 하나만. 코드펜스·다른 텍스트 금지.
7. narrative는 일반 투자자가 읽는다: 내부 id 숫자·영문 키(KOSPI_PROXY 등)·통계 전문용어(σ, Brier,
   베이스라인 b1/b2 등)를 쓰지 말고 "코스피", "코스닥", 섹터명과 일반 문장으로 쓴다.
   (rows의 id 필드는 예외 — 시스템 매칭용이므로 그대로 숫자를 넣는다)

출력 형식 (narrative는 서술형 문단 금지 — 짧은 불릿 3~5줄, 각 줄 '- '로 시작·70자 이내·줄바꿈 \\n 구분):
{"narrative":"- 시장: <전반 결과 한 줄>\\n- 잘된 점: <한 줄>\\n- 틀린 점: <한 줄>\\n- 다음 볼 것: <한 줄>",
 "rows":[{"id":<ledger_id 숫자>,"error_cause":"<범주 또는 null>","cause_certainty":"<확인됨|개연성 있음|확인 불가|null>","note":"<한 줄>"}]}

데이터:
${JSON.stringify(payload, null, 1)}`;
}

export function buildDailyPrompt(payload) {
  return `당신은 한국 주식시장 단기 확률예측 시스템의 일일 결산 분석가다.
아래는 오늘 하루 채점 요약과 최근 롤링 성과다.

규칙: 제공된 수치 밖의 원인(뉴스·수급·해외)은 단정하지 말 것. 하루 결과만으로 예측 규칙 변경을
제안하지 말 것(20거래일 표본 원칙). 매수·매도 추천 금지. 출력은 JSON 하나만, 코드펜스 금지.

출력 형식 (서술형 문단 금지 — 짧은 불릿 4~6줄, 각 줄 '- '로 시작·70자 이내·줄바꿈 \\n 구분):
{"narrative":"- 오늘 성과: <한 줄>\\n- 잘 맞춘 것: <한 줄>\\n- 틀린 패턴: <한 줄>\\n- 예상범위 상태: <80% 목표 대비 한 줄>\\n- 내일 볼 것: <한 줄>"}

데이터:
${JSON.stringify(payload, null, 1)}`;
}

export function parseLlmJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

// 범주·등급 강제 — LLM이 규칙 밖 값을 내면 안전값으로 강등
export function sanitizeRows(rows, validIds) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(r => validIds.has(Number(r.id)))
    .map(r => ({
      id: Number(r.id),
      error_cause: ERROR_CATEGORIES.includes(r.error_cause) ? r.error_cause : null,
      cause_certainty: CERTAINTY.includes(r.cause_certainty) ? r.cause_certainty : null,
      note: typeof r.note === 'string' ? r.note.slice(0, 200) : null,
    }))
    .map(r => (r.error_cause && !r.cause_certainty ? { ...r, cause_certainty: '확인 불가' } : r));
}

// 예측 시점 브리핑 — 뉴스(웹검색)·공시·수급·가격흐름을 종합해 "무엇을 볼지"를 쓴다.
// 숫자 예측은 여전히 엔진 소관 — 이 패스는 관찰 포인트와 맥락만 제공한다.
export function buildOutlookPrompt(payload) {
  return `당신은 한국 주식시장 데일리 브리핑 작성자다. 오늘 날짜와 아래 데이터가 주어진다.
웹검색(WebSearch)으로 오늘의 한국 증시 뉴스(코스피/코스닥 시황, 반도체·2차전지 등 주요 섹터,
미국 증시 마감, 환율)를 확인하고 아래 데이터와 종합하라.

규칙:
1. 사실과 추측 구분 — 뉴스에서 확인한 것은 "(뉴스)" 표기, 데이터에서 온 것은 그대로, 불확실하면 "추정".
2. 매수·매도·종목 추천 금지. "주목할 섹터/기업"은 관찰 대상 제시일 뿐임을 유지.
3. 공시 데이터가 stale이면 그 사실을 쓰고 지어내지 않는다.
4. 출력은 JSON 하나만, 코드펜스 금지. 각 배열 원소는 70자 이내 한 줄.

출력 형식:
{"news_sectors":["- (뉴스) <오늘 뉴스 기반 주목 섹터와 이유>", "..."],
 "flow_read":["- <수급·거래량 해석 한 줄>", "..."],
 "disclosure_watch":["- <공시 기반 주목 기업/이슈 또는 '공시 데이터 갱신 안 됨'>"],
 "risks":["- <오늘 예측을 뒤집을 수 있는 변수>", "..."]}

데이터:
${JSON.stringify(payload, null, 1)}`;
}

export function analyzeOutlook(payload, { invoke } = {}) {
  const call = invoke ?? ((p) => callClaude(p, { extraArgs: ['--allowedTools', 'WebSearch'], timeoutMs: 300_000 }));
  const parsed = parseLlmJson(call(buildOutlookPrompt(payload)));
  if (!parsed) return null;
  const arr = (x) => (Array.isArray(x) ? x.filter(s => typeof s === 'string').slice(0, 5) : []);
  const out = {
    news_sectors: arr(parsed.news_sectors), flow_read: arr(parsed.flow_read),
    disclosure_watch: arr(parsed.disclosure_watch), risks: arr(parsed.risks),
  };
  return Object.values(out).some(a => a.length) ? out : null;
}

// ── 최종 보고서 합성 (2026-07-21 사용자 규칙 v2) ─────────────
// 엔진 숫자는 불변 — LLM은 규칙 템플릿에 맞춰 근거 사슬과 판단을 서술한다.
export const BANNED_PHRASES = ['(합 100)', 'AI 세부 분석', '10번 중 8번'];

export function buildReportPrompt(payload) {
  return `당신은 한국 주식시장 단기 전망 보고서 작성자다. 아래 데이터로 최종 보고서를 작성한다.
${payload.allow_websearch ? '웹검색(WebSearch)으로 오늘 한국 증시·미 선물·환율 뉴스를 확인해 반영하라.' : '웹검색 없이 아래 데이터만 사용한다.'}

절대 규칙:
1. 예측 숫자(예상 수익률·80% 범위·오름/보합/내림 확률·확신도)는 아래 engine 값을 그대로 쓴다. 변경 금지.
2. 방향 문구는 숫자와 모순 금지. 확률 차이 8%p 미만이면 "혼조/방향성 낮음", 우세 방향은
   "약한 상승(하락) 우세", 확신 높음일 때만 "상승(하락) 우세". 예상 수익률 부호와 문구 일치 확인.
3. 금지 출력: "(합 100)" · "AI 세부 분석" 섹션 · 내부 검토 과정 · 잘된점/틀린점 자기평가 나열 ·
   근거 없는 "저가매수/차익실현/외국인 주도" 단정 · 예측에 반영 안 된 뉴스 나열 ·
   출처·시각 없는 수급/뉴스 · "10번 중 8번" 표현(커버리지 미검증) · 입력에 없는 숫자 창작.
4. 수급 표기: 전일 확정 수급을 당일 수급처럼 쓰지 않는다. 바스켓 수급은 반드시
   "제한된 대형주 바스켓 참고지표(N종목, 전일 확정)"로 표기. 시장 전체로 일반화 금지.
5. 판단 근거는 각각 [관측 사실 → 전달 경로 → 예측 반영 방향 → 강도(강/중/약) → 신뢰도(높/중/낮)]
   구조의 문장으로 쓴다. "최근 평균이 이래서" 한 줄 설명 금지 — 조건부 표본(cond_stats)과
   일반 표본(general_stats)의 차이·적용 가능성을 언급한다.
6. 공시는 목록 나열 금지 — 지수 영향 가능한 것만 [사실→의미→경로→방향/강도→반영]으로.
   소형주 공시로 지수 방향 논거 금지. 데이터 없으면 "미제공/확인 불가" 명시.
7. 매수·매도·종목 추천 금지. 모든 시각은 KST.
8. 반드시 아래 템플릿 구조와 섹션 헤더를 그대로 사용한다. 다른 섹션 추가 금지.
9. 가독성 (모바일 메신저 기준 — 위반 시 반려):
   - 섹션 사이, 그리고 판단 근거 번호 항목 사이에 반드시 빈 줄 1개.
   - 한 줄 45자 이내. 한 줄에 한 가지 생각만. 긴 문장은 줄을 나눈다.
   - 판단 근거는 한 문단 서술 금지 — 아래처럼 화살표 줄바꿈 구조로:
     1. 관측: 전일 -6.63% 급락
        → 경로: 유사 급락일(n=21) 평균 +0.92% 반등 경향
        → 반영: 예상치를 +쪽으로 (강도 중 · 신뢰도 중)
   - 【현재 시장 구조】는 문단이 아니라 "- " 불릿 줄로.
   - 모든 수치는 소수 2자리 반올림 (0.0879% → +0.09%).
10. 범위 라벨은 "예상 범위(적중 목표 80% · 폭 상한 10%p)"다. 80%는 이 시스템의 정확도 기준 —
    범위를 넓혀 달성하는 것이 금지돼 있으므로(폭 상한), 적중 미달은 변명 없이 성적에 기록된다.

템플릿:
📊 시장 전망 · {start} → {end} (KST)

【데이터 상태】
- 가격 기준: {시각} / 수급 기준: {전일 확정 여부} / 뉴스·공시: {시각 또는 미제공}
- 누락: {누락 데이터} / 신뢰도: {A/B/C}

【현재 시장 구조】
{전일 대비 위치·이틀 누적·장중 고저 내 위치·되돌림 정도·코스피/코스닥 상대강도·장세 체제 판단.
 시장 폭(상승/하락 종목수)·기여도 데이터가 없으면 "미제공" 명시. 4~7줄}

【코스피 전망】
{상승 우세/약한 상승 우세/혼조/약한 하락 우세/하락 우세} · 확신도: {낮음/보통/높음}
· 예상 수익률: {engine 값}% · 80% 예상 범위: {low}% ~ {high}%
· 오름 {p}% · 보합 {p}% · 내림 {p}%
판단 근거:
1. {관측→경로→반영→강도→신뢰도}
2. {...}
3. {...}
반대 근거:
- {현 전망을 무효화할 가장 강한 반대 요인}
최종 종합: {상방·하방 요인 충돌과 최종 방향·확률 결정 이유 2~4문장}

【코스닥 전망】
{코스피와 동일 형식 — 복사 금지, 코스닥 고유 수급·주도업종·변동성 차이 반영}

【공시·이벤트가 예측에 미친 영향】
{실제 반영된 것만: 시각|사실|의미|대상|경로|방향|강도|반영. 없으면 "이번 예측에 반영한 공시 없음"}

【예측을 뒤집을 조건】
- {관찰 가능한 수치·사건으로 2~3개. "심리 악화" 같은 모호한 표현 금지}

【직전 예측 검증】
{verification 데이터 그대로: 대상: 예상→실제 | 방향 | 절대오차 | 범위 | 핵심 원인 | 변경점 한 가지.
 없으면 "채점 대상 없음". 장황한 해설 금지}

【누적 성적】
{rolling 데이터 그대로: 60분/일간 분리. 표본 적으면 "표본 부족(n=N)" 명시}

데이터:
${JSON.stringify(payload, null, 1)}`;
}

export function validateReport(text) {
  if (!text || text.length < 300) return '너무 짧음';
  for (const b of BANNED_PHRASES) if (text.includes(b)) return `금지 문구: ${b}`;
  for (const h of ['【데이터 상태】', '【코스피 전망】', '【코스닥 전망】', '【직전 예측 검증】']) {
    if (!text.includes(h)) return `섹션 누락: ${h}`;
  }
  return null;
}

export function composeReport(payload, { invoke } = {}) {
  const call = invoke ?? ((p) => callClaude(p, {
    extraArgs: payload.allow_websearch ? ['--allowedTools', 'WebSearch'] : [],
    timeoutMs: 300_000,
  }));
  const out = (call(buildReportPrompt(payload)) ?? '').trim();
  const err = validateReport(out);
  return err ? { text: null, error: err } : { text: out, error: null };
}

export function callClaude(prompt, { timeoutMs = 180_000, extraArgs = [] } = {}) {
  // 프롬프트는 stdin으로 전달 — Windows shell 인자 한계(8191자)·따옴표 깨짐 회피
  const res = spawnSync('claude', ['-p', '--output-format', 'text', ...extraArgs], {
    shell: true, encoding: 'utf8', timeout: timeoutMs,
    input: prompt,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`claude CLI exit ${res.status}: ${(res.stderr || '').slice(0, 300)}`);
  return (res.stdout || '').trim();
}

export function llmEnabled(env = process.env) {
  return env.FORECAST_LLM !== '0';
}

/** 채점 결론 세부 분석 — 실패 시 null (보고는 계속 나간다) */
export function analyzeVerifications(payload, { invoke = callClaude } = {}) {
  const out = invoke(buildVerificationPrompt(payload));
  const parsed = parseLlmJson(out);
  if (!parsed || typeof parsed.narrative !== 'string') return null;
  const validIds = new Set(payload.verified.map(v => Number(v.id)));
  return { narrative: parsed.narrative.trim(), rows: sanitizeRows(parsed.rows, validIds) };
}

/** 일일 결산 해설 — 실패 시 null */
export function analyzeDaily(payload, { invoke = callClaude } = {}) {
  const out = invoke(buildDailyPrompt(payload));
  const parsed = parseLlmJson(out);
  if (!parsed || typeof parsed.narrative !== 'string') return null;
  return { narrative: parsed.narrative.trim() };
}
