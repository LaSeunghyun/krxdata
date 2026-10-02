/**
 * lib/earnings-calendar.mjs - 영업(잠정)실적 공시 이력에서 종목별 통상 발표 시기 도출 (순수 함수).
 * 슬롯: 접수월 1-3 -> Q4(전년 4분기·연간), 4-6 -> Q1, 7-9 -> Q2, 10-12 -> Q3.
 * 오프셋: 슬롯 시작일(1/1, 4/1, 7/1, 10/1)부터 접수일까지의 일수.
 * 사업연도가 12월 결산이 아닌 회사는 슬롯 해석이 달라질 수 있다(보고서에 한계로 명시).
 */

const SLOT_START_MONTH = { Q4: 1, Q1: 4, Q2: 7, Q3: 10 };
// 법정 제출기한(상한). 12월 결산 기준: 사업보고서 3/31, 1Q 5/15, 반기 8/14, 3Q 11/14.
export const STATUTORY_DEADLINE_MD = { Q4: '03-31', Q1: '05-15', Q2: '08-14', Q3: '11-14' };

export function slotOf(dateStr) {
  const m = Number(String(dateStr).slice(5, 7));
  if (!(m >= 1 && m <= 12)) return null;
  return m <= 3 ? 'Q4' : m <= 6 ? 'Q1' : m <= 9 ? 'Q2' : 'Q3';
}

const ms = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const fmt = (t) => new Date(t).toISOString().slice(0, 10);
const DAY = 86_400_000;

export function offsetDays(dateStr) {
  const slot = slotOf(dateStr);
  if (!slot) return null;
  const start = Date.UTC(+dateStr.slice(0, 4), SLOT_START_MONTH[slot] - 1, 1);
  return Math.round((ms(dateStr) - start) / DAY);
}

export function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : Math.round((a[h - 1] + a[h]) / 2);
}

/** 슬롯 시작일 + offset 이 today 이전이면 내년으로 넘긴 다음 예상일 */
export function nextExpected(slot, medianOffset, today) {
  const y = Number(today.slice(0, 4));
  for (const yy of [y, y + 1]) {
    const t = Date.UTC(yy, SLOT_START_MONTH[slot] - 1, 1) + medianOffset * DAY;
    if (fmt(t) >= today) return fmt(t);
  }
  return null;
}

/**
 * filings: [{stock_code, rcept_dt:'YYYY-MM-DD'}]. 같은 종목·같은 연도·같은 슬롯 중복은 가장 이른 날짜만.
 * minObs 미만이면 해당 슬롯은 만들지 않는다(음성 대조: 1건짜리로 '통상 시기'를 주장하지 않는다).
 */
export function deriveCalendar(filings, { today, minObs = 2, maxYears = 3 } = {}) {
  const by = new Map(); // `${code}|${slot}|${year}` -> earliest date
  for (const f of filings) {
    const d = String(f?.rcept_dt ?? '').slice(0, 10);
    const slot = slotOf(d);
    if (!f?.stock_code || !slot || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const k = `${f.stock_code}|${slot}|${d.slice(0, 4)}`;
    if (!by.has(k) || d < by.get(k)) by.set(k, d);
  }
  const groups = new Map(); // `${code}|${slot}` -> [dates]
  for (const [k, d] of by) {
    const [code, slot] = k.split('|');
    const g = `${code}|${slot}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(d);
  }
  const out = [];
  for (const [g, dates] of groups) {
    const [stock_code, slot] = g.split('|');
    dates.sort();
    const recent = dates.slice(-maxYears);
    if (recent.length < minObs) continue;
    const offs = recent.map(offsetDays);
    const med = median(offs);
    out.push({
      stock_code, slot, source: 'prelim_history', n_obs: recent.length,
      median_offset_days: med, min_offset_days: Math.min(...offs), max_offset_days: Math.max(...offs),
      last_filed: recent[recent.length - 1], next_expected: nextExpected(slot, med, today),
    });
  }
  return out;
}

/** 이력이 없는 (종목,슬롯)에 법정 기한(상한)을 채운다. source 로 구분. */
export function statutoryFallback(stockCodes, derived, { today }) {
  const have = new Set(derived.map(r => `${r.stock_code}|${r.slot}`));
  const out = [];
  for (const code of stockCodes) {
    for (const slot of Object.keys(STATUTORY_DEADLINE_MD)) {
      if (have.has(`${code}|${slot}`)) continue;
      const y = Number(today.slice(0, 4));
      let d = `${y}-${STATUTORY_DEADLINE_MD[slot]}`;
      if (d < today) d = `${y + 1}-${STATUTORY_DEADLINE_MD[slot]}`;
      out.push({ stock_code: code, slot, source: 'statutory_deadline', n_obs: 0, median_offset_days: null, min_offset_days: null, max_offset_days: null, last_filed: null, next_expected: d });
    }
  }
  return out;
}
