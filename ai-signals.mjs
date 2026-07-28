/**
 * ai-signals.mjs — 종목 1개의 다중신호 스냅샷 조립 (AI 판단기 입력).
 *
 * 신호원(2026-07-23 실측 가용):
 *  - 공시 촉매 + 원문 세부내용 (ai-events + ai-event-detail) ← 사용자 지시: 타이틀 말고 세부까지
 *  - 펀더/스코어 (stock_analysis: total_score·목표가·추천)
 *  - 모멘텀/52주 위치 (stock_analysis high/low + Toss 일봉 ret5/ret20)
 *  - 거래량비 (Toss 일봉: 당일/20일평균 — 촉매의 "확인"으로만, 추격 진입 아님)
 *  - 수급/매수주체 (stock_investor_flows: 외국인·기관 순매수, 커버되는 종목만)
 *  - 뉴스는 Google News RSS 스니펫을 캐시해 판단기 입력으로 전달(WebSearch 기본 off)
 */
import { classifyDisclosure } from './ai-events.mjs';
import { fetchDisclosureDetail } from './ai-event-detail.mjs';
import { searchStockNews } from './news-search.mjs';
import { getDailyPrices, getInvestOpinion, isKisConfigured } from './kis-api.js';

// 애널리스트 투자의견 정규화 — KIS가 한/영 혼용("매수"/"BUY"/"Outperform"/"NotRated")으로 주므로 텍스트 기반 분류.
//   (invt_opnn_cls_code는 같은 텍스트에 다른 코드가 오는 사례 실측 확인 → 코드 신뢰 안 함)
const opinionRank = (s) => {
  const t = String(s ?? '').toLowerCase().replace(/\s/g, '');
  if (!t || t.includes('notrated') || t === 'n/r' || t.includes('없음')) return null;
  if (/매도|sell|underperform|underweight|reduce/.test(t)) return 1;
  if (/중립|hold|neutral|marketperform|equalweight/.test(t)) return 2;
  if (/매수|buy|outperform|overweight|strongbuy|적극/.test(t)) return 3;
  return null; // 미분류는 집계 제외(억지 추정 금지)
};

/** 애널리스트 리포트 집계 — {covered, count, firms, consensusTarget, upsidePct, latestDate, buyRatio, upgrades, downgrades, recent[]} */
export function summarizeAnalyst(rows, price) {
  const rated = (rows ?? []).filter(r => opinionRank(r.opinion) != null);
  if (!rated.length) return { covered: false, count: 0, note: '최근 90일 애널리스트 커버리지 없음(또는 NotRated만)' };
  const targets = rated.map(r => r.targetPrice).filter(v => v && v > 0).sort((a, b) => a - b);
  const consensusTarget = targets.length ? targets[Math.floor(targets.length / 2)] : null; // 중앙값(극단 목표가 영향 완화)
  const buys = rated.filter(r => opinionRank(r.opinion) === 3).length;
  let upgrades = 0, downgrades = 0;
  for (const r of rated) {
    const cur = opinionRank(r.opinion), prev = opinionRank(r.prevOpinion);
    if (cur == null || prev == null) continue;
    if (cur > prev) upgrades++; else if (cur < prev) downgrades++;
  }
  return {
    covered: true,
    count: rated.length,
    firms: new Set(rated.map(r => r.firm)).size,
    consensusTarget,
    upsidePct: consensusTarget && price > 0 ? +((consensusTarget / price - 1) * 100).toFixed(1) : null,
    latestDate: rated[0]?.date ?? null,
    buyRatio: +(buys / rated.length).toFixed(2),
    upgrades,
    downgrades,
    recent: rated.slice(0, 5).map(r => ({ date: r.date, firm: r.firm, opinion: r.opinion, targetPrice: r.targetPrice })),
  };
}

const daysAgo = (n) => { const d = new Date(Date.now() - n * 86400000 + 9 * 3600000); return d.toISOString().slice(0, 10); };
const esc = (s) => String(s).replace(/'/g, "''");

/** @returns 신호 스냅샷 | null(미상장) */
export async function assembleSignals(code, {
  dbQuery,
  days = 7,
  withDetail = true,
  maxDetailChars = 1500,
  withNews = true,
  maxNews = 3,
  newsProvider = searchStockNews,
  withAnalyst = true,
  analystDays = 90,
}) {
  const rows = await dbQuery(`SELECT stock_code,corp_name,sector,current_price,total_score,short_score,long_score,
    recommendation,short_target_pct,mid_target_pct,high_52w,low_52w,market_cap_tril,avg_turnover_20d,bonus_flag
    FROM stock_analysis WHERE stock_code='${esc(code)}'`);
  const a = rows[0];
  if (!a) return null;

  // 촉매 공시 + 원문 세부
  const disc = await dbQuery(`SELECT rcept_no,rcept_dt,report_nm FROM stock_disclosures
    WHERE stock_code='${esc(code)}' AND rcept_dt>='${daysAgo(days)}' ORDER BY rcept_dt DESC LIMIT 15`);
  const events = [];
  for (const d of disc) {
    const c = classifyDisclosure(d.report_nm);
    if (!c.catalytic) continue;
    let detail = null;
    if (withDetail) { const dt = await fetchDisclosureDetail(d.rcept_no, { maxChars: maxDetailChars }); if (dt.ok) detail = dt.text; }
    events.push({ date: d.rcept_dt, type: c.type, polarity: c.polarity, title: String(d.report_nm).trim(), detail });
  }

  // 가격/거래량 — KIS 일봉(Toss와 별개 계좌 = 라이브봇 세션 경합 0, 거래량 포함=volRatio 복원). 실패 시 DB(stock_prices, volume없음) 폴백.
  let volRatio = null, ret5 = null, ret20 = null;
  if (isKisConfigured()) {
    try {
      const kd = await getDailyPrices(code); // 최신순 ~30거래일 (index 0 = 최근)
      const cl = kd.map(b => b.close), vols = kd.map(b => b.volume);
      if (cl.length >= 6) ret5 = +((cl[0] / cl[5] - 1) * 100).toFixed(1);
      if (cl.length >= 21) ret20 = +((cl[0] / cl[20] - 1) * 100).toFixed(1);
      if (vols.length >= 21 && vols[0] > 0) { const avg20 = vols.slice(1, 21).reduce((a, b) => a + b, 0) / 20; volRatio = avg20 > 0 ? +(vols[0] / avg20).toFixed(2) : null; }
    } catch { /* KIS 실패 → DB 폴백 */ }
  }
  if (ret5 == null) {
    const pr = await dbQuery(`SELECT close FROM stock_prices WHERE stock_code='${esc(code)}' ORDER BY date DESC LIMIT 25`);
    const cl = pr.map(r => Number(r.close)); // 최신순
    if (cl.length >= 6) ret5 = +((cl[0] / cl[5] - 1) * 100).toFixed(1);
    if (cl.length >= 21) ret20 = +((cl[0] / cl[20] - 1) * 100).toFixed(1);
  }

  // 수급 (커버 종목만)
  const flows = await dbQuery(`SELECT date,frgn_amt_mil,orgn_amt_mil,prsn_amt_mil FROM stock_investor_flows
    WHERE stock_code='${esc(code)}' ORDER BY date DESC LIMIT 5`);

  const pos52w = (a.high_52w && a.low_52w && a.high_52w > a.low_52w)
    ? +(((a.current_price - a.low_52w) / (a.high_52w - a.low_52w)) * 100).toFixed(0) : null;
  let news = [];
  if (withNews) {
    try { news = await newsProvider({ code, name: a.corp_name }, { limit: maxNews }); }
    catch { news = []; }
  }

  // 애널리스트 리포트(KIS 종목투자의견) — 증권사별 목표가·투자의견·직전의견(상하향 조정). Toss 경합 없음.
  let analyst = { covered: false, count: 0, note: '조회 안 함' };
  if (withAnalyst && isKisConfigured()) {
    try { analyst = summarizeAnalyst(await getInvestOpinion(code, { days: analystDays }), Number(a.current_price)); }
    catch (e) { analyst = { covered: false, count: 0, note: `조회 실패: ${String(e.message).slice(0, 60)}` }; }
  }

  return {
    code, name: a.corp_name, sector: a.sector, price: a.current_price,
    score: { total: a.total_score, short: a.short_score, long: a.long_score, reco: a.recommendation, shortTargetPct: a.short_target_pct, midTargetPct: a.mid_target_pct },
    momentum: { ret5, ret20, pos52w, high52w: a.high_52w, low52w: a.low_52w },
    volume: { volRatio },
    liquidity_krw: a.avg_turnover_20d, mcap_tril: a.market_cap_tril, bonus_flag: a.bonus_flag,
    flows: flows.map(f => ({ date: f.date, frgn_mil: f.frgn_amt_mil, orgn_mil: f.orgn_amt_mil, prsn_mil: f.prsn_amt_mil })),
    events,
    news,
    analyst,
  };
}

/** 촉매 트리거: 최근 days일 촉매공시 뜬 유동성 종목 코드 목록 (AI 판단 비용통제 = 이들만 평가) */
export async function catalyticCandidates({ dbQuery, days = 3, minTurnover = 3e9 }) {
  const rows = await dbQuery(`SELECT DISTINCT d.stock_code
    FROM stock_disclosures d JOIN stock_analysis a ON a.stock_code=d.stock_code
    WHERE d.rcept_dt>='${daysAgo(days)}' AND a.avg_turnover_20d>=${minTurnover} AND a.current_price>=1000`);
  const codes = rows.map(r => r.stock_code);
  // report_nm 촉매 필터는 assemble 단계에서 (여기선 후보 축소만)
  return codes;
}
