import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNum, parseKrDate, sqlNum, sqlStr, parseFlowRows, parseCreditRows, parseShortRows, parseLoanRows, parseGlobalRows, parseBondDecision, isEarningsPrelimTitle } from '../lib/parsers.mjs';
import { slotOf, offsetDays, median, deriveCalendar, statutoryFallback, nextExpected } from '../lib/earnings-calendar.mjs';

test('toNum / parseKrDate / sql 빌더', () => {
  assert.equal(toNum('5,800,000,000'), 5800000000);
  assert.equal(toNum('-'), null); assert.equal(toNum(''), null); assert.equal(toNum('abc'), null); assert.equal(toNum(null), null);
  assert.equal(parseKrDate('2026년 09월 30일'), '2026-09-30');
  assert.equal(parseKrDate('-'), null); assert.equal(parseKrDate('2026년 13월 01일'), null);
  assert.equal(sqlNum('1,2x'), 'NULL'); assert.equal(sqlNum(0), '0');
  assert.equal(sqlStr("a'b"), "'a''b'"); assert.equal(sqlStr(null), 'NULL');
});

test('parseFlowRows: 정상 + 음성 대조(배열 아님/날짜 형식 불량/close 결측)', () => {
  const rows = parseFlowRows([{ date: '20260930', close: 100, frgn_amt_mil: 5, orgn_amt_mil: -3, prsn_amt_mil: '' }]);
  assert.deepEqual(rows, [{ date: '20260930', close: 100, frgn: 5, orgn: -3, prsn: 0 }]);
  assert.throws(() => parseFlowRows({ output: [] }), /형식 오류/);
  assert.equal(parseFlowRows([{ date: '2026-09-30', close: 1 }, { date: '20260930', close: null }, { date: '20260930', close: 'x' }]).length, 0);
});

test('parseCreditRows: 실측 샘플(삼성전자 2026-09-28) 매핑 + 불량 입력 거부', () => {
  const j = { output: [{ deal_date: '20260928', stck_prpr: '270000', stlm_date: '20260930', whol_loan_new_stcn: '3026557', whol_loan_rdmp_stcn: '1485470', whol_loan_rmnd_stcn: '22157588', whol_loan_new_amt: '73095033', whol_loan_rdmp_amt: '34401838', whol_loan_rmnd_amt: '485991342', whol_loan_rmnd_rate: '0.36', whol_loan_gvrt: '14.17', whol_stln_new_stcn: '1290', whol_stln_rdmp_stcn: '3559', whol_stln_rmnd_stcn: '10333', whol_stln_rmnd_amt: '230444', whol_stln_rmnd_rate: '0.00' }] };
  const [r] = parseCreditRows(j);
  assert.equal(r.date, '20260928'); assert.equal(r.loan_balance_shares, 22157588); assert.equal(r.loan_gvrt, 14.17); assert.equal(r.stln_balance_shares, 10333);
  assert.throws(() => parseCreditRows({ rt_cd: '1' }), /output/);
  assert.throws(() => parseCreditRows({ output: 'x' }), /output/);
  assert.equal(parseCreditRows({ output: [{ deal_date: '9/28', whol_loan_rmnd_stcn: '1' }, { deal_date: '20260928', whol_loan_rmnd_stcn: '' }] }).length, 0);
});

test('parseShortRows: 실측 샘플 매핑 + output2 없으면 throw', () => {
  const j = { output1: {}, output2: [{ stck_bsop_date: '20260930', stck_clpr: '268500', acml_vol: '16477580', ssts_cntg_qty: '1069129', ssts_vol_rlim: '6.49', acml_ssts_cntg_qty: '17342777', acml_ssts_cntg_qty_rlim: '5.14', ssts_tr_pbmn: '288928434000', ssts_tr_pbmn_rlim: '6.48', acml_ssts_tr_pbmn: '4515438932750', acml_ssts_tr_pbmn_rlim: '5.04', avrg_prc: '270246' }] };
  const [r] = parseShortRows(j);
  assert.equal(r.short_vol, 1069129); assert.equal(r.short_vol_ratio, 6.49); assert.equal(r.short_amt, 288928434000);
  assert.throws(() => parseShortRows({ output1: {} }), /output2/);
  assert.equal(parseShortRows({ output2: [{ stck_bsop_date: '20260930', ssts_cntg_qty: '' }] }).length, 0);
});

test('parseLoanRows: 실측 샘플 매핑 + 불량 거부', () => {
  const [r] = parseLoanRows({ output1: [{ bsop_date: '20260930', stck_prpr: '268500.00', new_stcn: '1328885', rdmp_stcn: '1698300', prdy_rmnd_vrss: '-369415', rmnd_stcn: '74382737', rmnd_amt: '19971764' }] });
  assert.equal(r.balance_shares, 74382737); assert.equal(r.balance_chg, -369415); assert.equal(r.close, 268500);
  assert.throws(() => parseLoanRows({ output2: [] }), /output1/);
});

test('parseGlobalRows: 오늘(KST) 이후 행·종가 0 이하 제외', () => {
  const j = { output2: [
    { stck_bsop_date: '20261001', ovrs_nmix_prpr: '1360.2' },   // 오늘: 장중 미확정 -> 제외
    { stck_bsop_date: '20260930', ovrs_nmix_prpr: '12628.62', ovrs_nmix_oprc: '12665.67', ovrs_nmix_hgpr: '12731.10', ovrs_nmix_lwpr: '12555.65' },
    { stck_bsop_date: '20260929', ovrs_nmix_prpr: '0' },
    { stck_bsop_date: 'bad', ovrs_nmix_prpr: '1' },
  ] };
  const rows = parseGlobalRows(j, { today: '20261001' });
  assert.equal(rows.length, 1); assert.equal(rows[0].date, '20260930'); assert.equal(rows[0].close, 12628.62);
  assert.throws(() => parseGlobalRows({ output1: {} }, { today: '20261001' }), /output2/);
});

test('parseBondDecision: CB 실측(진시스템) / BW 필드 매핑 + 필수값 결측 거부', () => {
  const cb = { rcept_no: '20260930000411', corp_code: '01437858', corp_name: '진시스템', bddd: '2026년 09월 30일', bd_tm: '1', bd_knd: '전환사채', bd_fta: '5,800,000,000', cv_rt: '100', cv_prc: '4,141', cvisstk_cnt: '1,400,627', cvisstk_tisstk_vs: '16.46', cvrqpd_bgd: '2027년 10월 08일', cvrqpd_edd: '2029년 09월 08일', bd_mtd: '2029년 10월 08일', act_mktprcfl_cvprc_lwtrsprc: '-', pymd: '2026년 10월 08일', ovis_fta: '-' };
  const r = parseBondDecision('CB', cb, '363250');
  assert.equal(r.conv_price, 4141); assert.equal(r.new_shares, 1400627); assert.equal(r.new_shares_pct, 16.46); assert.equal(r.period_start, '2027-10-08'); assert.equal(r.min_adjust_price, null); assert.equal(r.is_overseas, false);
  const bw = { rcept_no: '20260521000491', corp_code: '00244747', bddd: '2026년 05월 21일', bd_fta: '100,000,000,000', ex_rt: '100.0', ex_prc: '267,747', nstk_isstk_cnt: '373,486', nstk_isstk_tisstk_vs: '5.34', expd_bgd: '2027년 06월 08일', expd_edd: '2056년 05월 08일' };
  const b = parseBondDecision('BW', bw, '140860');
  assert.equal(b.conv_price, 267747); assert.equal(b.new_shares, 373486); assert.equal(b.period_end, '2056-05-08');
  // 음성 대조
  assert.equal(parseBondDecision('CB', { ...cb, bd_fta: '-' }, '363250'), null);
  assert.equal(parseBondDecision('CB', { ...cb, bddd: '-' }, '363250'), null);
  assert.equal(parseBondDecision('CB', cb, ''), null);          // 비상장(종목코드 없음)
  assert.equal(parseBondDecision('EB', cb, '363250'), null);    // 지원하지 않는 종류
  assert.equal(parseBondDecision('CB', null, '363250'), null);
});

test('isEarningsPrelimTitle: 최초 영업(잠정)실적만, 정정·자회사 제외', () => {
  assert.equal(isEarningsPrelimTitle('연결재무제표기준영업(잠정)실적(공정공시)              '), true);
  assert.equal(isEarningsPrelimTitle('영업(잠정)실적(공정공시)'), true);
  assert.equal(isEarningsPrelimTitle('[기재정정]영업(잠정)실적(공정공시)'), false);
  assert.equal(isEarningsPrelimTitle('영업(잠정)실적(공정공시)(자회사의 주요경영사항)'), false);
  assert.equal(isEarningsPrelimTitle('단일판매ㆍ공급계약체결'), false);
  assert.equal(isEarningsPrelimTitle(null), false);
});

test('오늘(KST) 행은 장중 미확정이라 신용/공매도/대차 파서가 제외한다(음성 대조)', () => {
  const s = parseShortRows({ output2: [{ stck_bsop_date: '20261001', ssts_cntg_qty: '5' }, { stck_bsop_date: '20260930', ssts_cntg_qty: '7' }] }, { today: '20261001' });
  assert.deepEqual(s.map(r => r.date), ['20260930']);
  const l = parseLoanRows({ output1: [{ bsop_date: '20261001', rmnd_stcn: '5' }, { bsop_date: '20260930', rmnd_stcn: '7' }] }, { today: '20261001' });
  assert.deepEqual(l.map(r => r.date), ['20260930']);
  const c = parseCreditRows({ output: [{ deal_date: '20261001', whol_loan_rmnd_stcn: '5' }, { deal_date: '20260930', whol_loan_rmnd_stcn: '7' }] }, { today: '20261001' });
  assert.deepEqual(c.map(r => r.date), ['20260930']);
});

test('earnings calendar: 슬롯·오프셋·중앙값·다음 예상일', () => {
  assert.equal(slotOf('2026-02-10'), 'Q4'); assert.equal(slotOf('2026-05-10'), 'Q1'); assert.equal(slotOf('2026-08-01'), 'Q2'); assert.equal(slotOf('2026-11-05'), 'Q3');
  assert.equal(offsetDays('2026-04-10'), 9);
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 3]), 2); assert.equal(median([]), null);
  assert.equal(nextExpected('Q3', 9, '2026-10-01'), '2026-10-10');
  assert.equal(nextExpected('Q1', 9, '2026-10-01'), '2027-04-10'); // 올해 지났으면 내년
});

test('deriveCalendar: 3년 이력으로 통상 시기 도출, 표본 1건은 만들지 않는다(음성 대조)', () => {
  const f = [
    { stock_code: '000001', rcept_dt: '2024-05-10' }, { stock_code: '000001', rcept_dt: '2025-05-12' }, { stock_code: '000001', rcept_dt: '2026-05-08' },
    { stock_code: '000002', rcept_dt: '2026-05-08' },                       // 1건만 -> 제외
    { stock_code: '000003', rcept_dt: '2025-08-05' }, { stock_code: '000003', rcept_dt: '2025-08-20' }, // 같은 해 중복 -> 1건으로 집계 -> 제외
    { stock_code: '', rcept_dt: '2026-05-08' }, { stock_code: '000004', rcept_dt: 'bad' },
  ];
  const d = deriveCalendar(f, { today: '2026-10-01' });
  assert.equal(d.length, 1);
  assert.equal(d[0].stock_code, '000001'); assert.equal(d[0].slot, 'Q1'); assert.equal(d[0].n_obs, 3);
  assert.equal(d[0].median_offset_days, 39); // 4/1 기준 오프셋 39,41,37 -> 중앙 39
  assert.equal(d[0].next_expected, '2027-05-10');
  const fb = statutoryFallback(['000001', '000002'], d, { today: '2026-10-01' });
  assert.equal(fb.length, 7); // 000001 은 Q1 이 이미 있어 3개, 000002 는 4개
  assert.ok(fb.every(r => r.source === 'statutory_deadline' && r.n_obs === 0));
  assert.equal(fb.find(r => r.stock_code === '000002' && r.slot === 'Q3').next_expected, '2026-11-14');
  assert.equal(fb.find(r => r.stock_code === '000002' && r.slot === 'Q1').next_expected, '2027-05-15');
});
