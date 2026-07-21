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
