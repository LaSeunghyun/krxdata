/**
 * ai-events.mjs — 공시 report_nm 텍스트를 이벤트 타입/호재·악재/촉매여부로 분류.
 *
 * stock_disclosures.report_type이 전부 null이라 report_nm 텍스트로만 분류한다.
 * 목적: AI 판단 트레이더의 "공시" 신호 — 어떤 종목에 촉매성 이벤트가 떴는지 골라낸다.
 *
 * 설계 원칙(정직):
 *  - polarity는 "일반적 방향성"일 뿐 확정 아님. 실적·대량보유·최대주주변경은 내용(숫자·매수/매도)을
 *    안 읽으면 부호를 모른다 → 'review'로 두고 AI/사람이 원문을 봐야 한다(사후 스토리텔링 방지).
 *  - catalytic=true 인 것만 AI 판단 대상 후보. routine(정기보고·형식공시)은 노이즈로 제외.
 */

// 우선순위 순서 — 먼저 매칭되는 규칙이 이긴다(구체적인 것 위로).
const RULES = [
  // ── 촉매성 호재 ──────────────────────────────────────────
  { type: '무상증자',       re: /무상증자결정/,                       polarity: 'positive', catalytic: true },
  { type: '자사주취득',     re: /자기주식취득(?!.*처분)|자기주식취득신탁계약(?!.*해지)/, polarity: 'positive', catalytic: true },
  { type: '수주계약',       re: /단일판매.?공급계약체결/,             polarity: 'positive', catalytic: true },
  { type: '현금배당',       re: /현금.?현물배당결정|배당결정/,        polarity: 'positive', catalytic: true },
  { type: '자사주소각',     re: /자기주식소각|주식소각결정|주식소각/, polarity: 'positive', catalytic: true },
  { type: '기업가치제고',   re: /기업가치제고|밸류업/,                polarity: 'positive', catalytic: true },
  { type: '흑자전환',       re: /흑자전환|영업이익.?흑자/,            polarity: 'positive', catalytic: true },
  // ── 촉매성 악재 ──────────────────────────────────────────
  { type: '유상증자',       re: /유상증자결정/,                       polarity: 'negative', catalytic: true },
  { type: '전환사채등',     re: /전환사채|신주인수권부사채|교환사채/,  polarity: 'negative', catalytic: true },
  { type: '자사주처분',     re: /자기주식.?처분|자기주식취득신탁계약해지/, polarity: 'negative', catalytic: true },
  { type: '감자',           re: /감자결정/,                           polarity: 'negative', catalytic: true },
  { type: '적자전환',       re: /적자전환|영업손실/,                  polarity: 'negative', catalytic: true },
  { type: '계약해지',       re: /공급계약.*해지|계약.*중도해지/,      polarity: 'negative', catalytic: true },
  { type: '관리상폐',       re: /관리종목|상장폐지|상장적격성|거래정지/, polarity: 'negative', catalytic: true },
  { type: '사건사고',       re: /횡령|배임|소송|불성실공시법인지정|벌금|과징금/, polarity: 'negative', catalytic: true },
  { type: '채무보증',       re: /타인에대한채무보증|채무보증결정/,    polarity: 'negative', catalytic: true },
  // ── 촉매성·부호미정(원문 필요) ───────────────────────────
  { type: '실적',           re: /영업.?잠정.?실적|잠정실적|매출액또는손익구조|연결재무제표기준영업.?잠정.?실적|영업.잠정.실적.공정공시|실적.?공정공시/, polarity: 'review', catalytic: true },
  { type: '대량보유5%',     re: /대량보유상황보고/,                   polarity: 'review', catalytic: true },
  { type: '임원주주변동',   re: /임원.?주요주주.*소유(상황|변동)|특정증권등거래계획/, polarity: 'review', catalytic: true },
  { type: '최대주주변경',   re: /최대주주.*변경|최대주주등소유주식변동/, polarity: 'review', catalytic: true },
  { type: '주식양수도',     re: /주식양수도|경영권|타법인주식.*양수/,  polarity: 'review', catalytic: true },
  { type: '타법인투자',     re: /타법인주식.*취득|출자증권취득/,       polarity: 'review', catalytic: true },
  { type: '유형자산',       re: /유형자산.?양수|영업양수도|합병|분할/, polarity: 'review', catalytic: true },
  { type: '경영중요사항',   re: /투자판단관련주요경영사항/,           polarity: 'review', catalytic: true },
  // ── 약촉매/중립 ──────────────────────────────────────────
  { type: 'IR개최',         re: /기업설명회.?IR|IR.?개최/,            polarity: 'neutral',  catalytic: false },
  { type: '소속부변경',     re: /소속부변경/,                         polarity: 'neutral',  catalytic: false },
  // ── 노이즈(정기·형식공시) — 제외 ─────────────────────────
  { type: '정기보고',       re: /분기보고서|반기보고서|사업보고서|감사보고서/, polarity: 'neutral', catalytic: false },
  { type: '형식공시',       re: /지배구조보고서|투자설명서|증권발행실적|일괄신고|의결권.?대리|참고서류|지속가능경영|대규모기업집단|주주명부폐쇄|주주총회소집|주식매수선택권|기업집단현황|영업실적등에관한전망/, polarity: 'neutral', catalytic: false },
];

/** report_nm → { type, polarity, catalytic } */
export function classifyDisclosure(reportNm) {
  const nm = String(reportNm || '').replace(/\[기재정정\]|\[첨부정정\]|\[기타공시\]|\s/g, '');
  const corrected = /^\[.*정정\]/.test(String(reportNm || '')) || String(reportNm || '').includes('정정');
  for (const r of RULES) {
    if (r.re.test(nm)) return { type: r.type, polarity: r.polarity, catalytic: r.catalytic, corrected };
  }
  return { type: '기타', polarity: 'neutral', catalytic: false, corrected };
}

/** 여러 공시 행 → 촉매성만 필터 + 종목별 집계 */
export function catalyticEvents(rows) {
  return rows
    .map(r => ({ ...r, ...classifyDisclosure(r.report_nm ?? r.nm) }))
    .filter(e => e.catalytic);
}
