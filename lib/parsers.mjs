/**
 * lib/parsers.mjs - 외부 API 응답 파서 + SQL 값 빌더 (순수 함수, 네트워크 의존 없음).
 * 원칙: 형식이 틀린 응답(배열 아님, 날짜 형식 불일치, 필수 숫자 결측)은 조용히 통과시키지 않는다.
 *   - 응답 구조 자체가 틀리면 throw (호출 측이 실패로 집계)
 *   - 개별 행이 틀리면 그 행만 버리고 dropped 로 센다
 */

/** "1,234" -> 1234, ""/"-"/null/NaN -> null */
export function toNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const YMD8 = /^\d{8}$/;
const CODE6 = /^[A-Za-z0-9]{6}$/;
export const isYmd8 = (s) => YMD8.test(String(s ?? ''));
export const isStockCode = (s) => CODE6.test(String(s ?? ''));

/** "2026년 09월 30일" -> "2026-09-30", 그 외 null */
export function parseKrDate(s) {
  const m = /^\s*(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** SQL 숫자 리터럴 (null/NaN -> NULL). 문자열 주입 방지를 위해 항상 Number 경유. */
export function sqlNum(v) {
  const n = toNum(v);
  return n == null ? 'NULL' : String(n);
}
/** SQL 문자열 리터럴 (작은따옴표 이스케이프, null -> NULL) */
export function sqlStr(v) {
  if (v == null) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

const need = (cond, msg) => { if (!cond) throw new Error(`응답 형식 오류: ${msg}`); };

/** KST 오늘 YYYYMMDD */
export function kstToday(now = Date.now()) {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

/** KIS 투자자 수급 행 -> [{date, close, frgn, orgn, prsn}] (getInvestorDaily 결과 입력) */
export function parseFlowRows(flows) {
  need(Array.isArray(flows), 'flows 가 배열이 아님');
  const rows = [];
  for (const f of flows) {
    if (!isYmd8(f?.date)) continue;
    const close = toNum(f.close);
    if (close == null) continue;
    rows.push({ date: f.date, close, frgn: toNum(f.frgn_amt_mil) ?? 0, orgn: toNum(f.orgn_amt_mil) ?? 0, prsn: toNum(f.prsn_amt_mil) ?? 0 });
  }
  return rows;
}

/** 신용잔고 일별추이 FHPST04760000 (output 배열). 키는 deal_date(매매일). */
export function parseCreditRows(j, { today = kstToday() } = {}) {
  need(j && Array.isArray(j.output), 'output 배열 없음');
  const rows = [];
  for (const r of j.output) {
    if (!isYmd8(r?.deal_date) || r.deal_date >= today) continue;
    const bal = toNum(r.whol_loan_rmnd_stcn);
    if (bal == null) continue;
    rows.push({
      date: r.deal_date, stlm_date: isYmd8(r.stlm_date) ? r.stlm_date : null, close: toNum(r.stck_prpr),
      loan_new_shares: toNum(r.whol_loan_new_stcn), loan_rdmp_shares: toNum(r.whol_loan_rdmp_stcn), loan_balance_shares: bal,
      loan_new_amt: toNum(r.whol_loan_new_amt), loan_rdmp_amt: toNum(r.whol_loan_rdmp_amt), loan_balance_amt: toNum(r.whol_loan_rmnd_amt),
      loan_balance_rate: toNum(r.whol_loan_rmnd_rate), loan_gvrt: toNum(r.whol_loan_gvrt),
      stln_new_shares: toNum(r.whol_stln_new_stcn), stln_rdmp_shares: toNum(r.whol_stln_rdmp_stcn), stln_balance_shares: toNum(r.whol_stln_rmnd_stcn),
      stln_balance_amt: toNum(r.whol_stln_rmnd_amt), stln_balance_rate: toNum(r.whol_stln_rmnd_rate),
    });
  }
  return rows;
}

/** 공매도 일별추이 FHPST04830000 (output2 배열). */
export function parseShortRows(j, { today = kstToday() } = {}) {
  need(j && Array.isArray(j.output2), 'output2 배열 없음');
  const rows = [];
  for (const r of j.output2) {
    if (!isYmd8(r?.stck_bsop_date) || r.stck_bsop_date >= today) continue;
    const sv = toNum(r.ssts_cntg_qty);
    if (sv == null) continue;
    rows.push({
      date: r.stck_bsop_date, close: toNum(r.stck_clpr), volume: toNum(r.acml_vol),
      short_vol: sv, short_vol_ratio: toNum(r.ssts_vol_rlim),
      short_acc_vol: toNum(r.acml_ssts_cntg_qty), short_acc_vol_ratio: toNum(r.acml_ssts_cntg_qty_rlim),
      short_amt: toNum(r.ssts_tr_pbmn), short_amt_ratio: toNum(r.ssts_tr_pbmn_rlim),
      short_acc_amt: toNum(r.acml_ssts_tr_pbmn), short_acc_amt_ratio: toNum(r.acml_ssts_tr_pbmn_rlim),
      avg_price: toNum(r.avrg_prc),
    });
  }
  return rows;
}

/** 대차거래 일별추이 HHPST074500C0 (output1 배열). */
export function parseLoanRows(j, { today = kstToday() } = {}) {
  need(j && Array.isArray(j.output1), 'output1 배열 없음');
  const rows = [];
  for (const r of j.output1) {
    if (!isYmd8(r?.bsop_date) || r.bsop_date >= today) continue;
    const bal = toNum(r.rmnd_stcn);
    if (bal == null) continue;
    rows.push({
      date: r.bsop_date, close: toNum(r.stck_prpr), new_shares: toNum(r.new_stcn), rdmp_shares: toNum(r.rdmp_stcn),
      balance_chg: toNum(r.prdy_rmnd_vrss), balance_shares: bal, balance_amt_mil: toNum(r.rmnd_amt),
    });
  }
  return rows;
}

/** 해외지수/환율 일봉 FHKST03030100 (output2 배열). 오늘(KST) 이후 날짜는 장중 미확정이라 제외. */
export function parseGlobalRows(j, { today = kstToday() } = {}) {
  need(j && Array.isArray(j.output2), 'output2 배열 없음');
  const rows = [];
  for (const r of j.output2) {
    if (!isYmd8(r?.stck_bsop_date) || r.stck_bsop_date >= today) continue;
    const close = toNum(r.ovrs_nmix_prpr);
    if (close == null || close <= 0) continue;
    rows.push({ date: r.stck_bsop_date, open: toNum(r.ovrs_nmix_oprc), high: toNum(r.ovrs_nmix_hgpr), low: toNum(r.ovrs_nmix_lwpr), close });
  }
  return rows;
}

/** OpenDART 전환사채/신주인수권부사채 발행결정 한 건 -> 정규화 행. 필수값 결측이면 null. */
export function parseBondDecision(kind, r, stockCode) {
  if (!r || (kind !== 'CB' && kind !== 'BW')) return null;
  if (!r.rcept_no || !r.corp_code || !isStockCode(stockCode)) return null;
  const decision = parseKrDate(r.bddd);
  const face = toNum(r.bd_fta);
  if (!decision || face == null || face <= 0) return null;
  const isCb = kind === 'CB';
  return {
    rcept_no: String(r.rcept_no), stock_code: stockCode, corp_code: String(r.corp_code), corp_name: r.corp_name ?? null, kind,
    decision_date: decision, bond_round: toNum(r.bd_tm), bond_kind: r.bd_knd ?? null, face_amount: face,
    issue_method: r.bdis_mthn ?? null, coupon_rate: toNum(r.bd_intr_ex), ytm_rate: toNum(r.bd_intr_sf), maturity_date: parseKrDate(r.bd_mtd),
    conv_ratio: toNum(isCb ? r.cv_rt : r.ex_rt), conv_price: toNum(isCb ? r.cv_prc : r.ex_prc),
    new_shares: toNum(isCb ? r.cvisstk_cnt : r.nstk_isstk_cnt), new_shares_pct: toNum(isCb ? r.cvisstk_tisstk_vs : r.nstk_isstk_tisstk_vs),
    period_start: parseKrDate(isCb ? r.cvrqpd_bgd : r.expd_bgd), period_end: parseKrDate(isCb ? r.cvrqpd_edd : r.expd_edd),
    min_adjust_price: toNum(r.act_mktprcfl_cvprc_lwtrsprc), pay_date: parseKrDate(r.pymd),
    is_overseas: toNum(r.ovis_fta) != null && toNum(r.ovis_fta) > 0,
    raw: r,
  };
}

/** list.json 의 영업(잠정)실적 공시인가. 정정본·자회사 공시는 제외(최초 공시일만 의미 있음). */
export function isEarningsPrelimTitle(reportNm) {
  const t = String(reportNm ?? '').replace(/\s+/g, '');
  if (t.startsWith('[')) return false;               // [기재정정] 등
  if (t.includes('자회사')) return false;
  return /영업\(잠정\)실적/.test(t);
}
