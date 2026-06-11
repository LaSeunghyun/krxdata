// IC·포워드수익·point-in-time (순수 코어 수학). NaN/Infinity 절대 미반환.

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

// 동순위=평균순위 변환
function rankAverage(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // 1-base 평균순위
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

export function spearmanIC(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 2) return 0;
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const rx = rankAverage(xs);
  const ry = rankAverage(ys);
  const n = rx.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx;
    const dy = ry[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return 0; // 상수축
  const r = cov / Math.sqrt(vx * vy);
  if (!Number.isFinite(r)) return 0;
  return Math.max(-1, Math.min(1, r));
}

export function excessReturn(p0, pN, b0, bN) {
  if (!(p0 > 0) || !(b0 > 0)) return null;
  return (pN / p0 - 1) - (bN / b0 - 1);
}

export function pointInTimeFinancials(rows, asOf) {
  return rows.filter((r) => String(r.rcept_dt) <= String(asOf));
}

export function alignForward(snapshots, horizonDays, toleranceDays) {
  const byStock = new Map();
  for (const s of snapshots) {
    if (!byStock.has(s.stock_code)) byStock.set(s.stock_code, []);
    byStock.get(s.stock_code).push(s);
  }
  const lo = horizonDays - toleranceDays;
  const hi = horizonDays + toleranceDays;
  const out = [];
  for (const [stock_code, snaps] of byStock) {
    for (const t of snaps) {
      const t0 = Date.parse(t.date);
      let best = null;
      let bestDist = Infinity;
      for (const cand of snaps) {
        const days = Math.round((Date.parse(cand.date) - t0) / 86400000);
        if (days <= 0) continue; // T 자신·과거 금지 (미래만)
        if (days < lo || days > hi) continue;
        const dist = Math.abs(days - horizonDays);
        if (dist < bestDist) {
          bestDist = dist;
          best = cand;
        }
      }
      if (best) {
        out.push({ stock_code, t: t.date, p0: t.price, pN: best.price });
      }
    }
  }
  return out;
}

// 한 종목의 재무 행들 중 rcept_dt <= asOf 인 최신 행. 동률이면 analysis_year 큰 쪽.
export function latestFinancialAsOf(rows, asOf) {
  if (!Array.isArray(rows)) return null;
  let best = null;
  for (const r of rows) {
    if (r?.rcept_dt == null) continue;
    const d = String(r.rcept_dt);
    if (d > String(asOf)) continue;
    if (
      best === null ||
      d > String(best.rcept_dt) ||
      (d === String(best.rcept_dt) && (r.analysis_year ?? 0) > (best.analysis_year ?? 0))
    ) best = r;
  }
  return best;
}

// closes[startIdx..endIdx] 구간에 |일간변동| > threshold 또는 비정상가(<=0) 존재 여부.
// 수정주가 미보유 환경에서 액면분할·무상증자 왜곡 관측 제외용. KR 가격제한폭 ±30% → 기본 0.35.
export function hasExtremeGap(closes, startIdx, endIdx, threshold = 0.35) {
  const lo = Math.max(1, startIdx + 1);
  const hi = Math.min(closes.length - 1, endIdx);
  for (let i = lo; i <= hi; i++) {
    const a = closes[i - 1], b = closes[i];
    if (!(a > 0) || !(b > 0)) return true;
    if (Math.abs(b / a - 1) > threshold) return true;
  }
  return false;
}

// rcept_dt 미보유 행의 보수적(법정기한+여유) 공시 추정일
export function estimateRceptDt(analysisYear, reportCode = "11011") {
  const y = Number(analysisYear);
  switch (String(reportCode)) {
    case "11013": return `${y}0516`; // 1분기보고서
    case "11012": return `${y}0815`; // 반기보고서
    case "11014": return `${y}1115`; // 3분기보고서
    default:      return `${y + 1}0401`; // 사업보고서
  }
}

export function quantileSpread(rows, scoreKey, retKey, q = 0.2) {
  const valid = rows.filter(
    (r) => isFiniteNum(r[scoreKey]) && isFiniteNum(r[retKey]),
  );
  const n = valid.length;
  if (n === 0) return 0;
  const sorted = valid.slice().sort((a, b) => b[scoreKey] - a[scoreKey]);
  const k = Math.max(1, Math.round(n * q));
  const top = sorted.slice(0, k);
  const bottom = sorted.slice(n - k);
  const avg = (xs) => xs.reduce((a, r) => a + r[retKey], 0) / xs.length;
  return avg(top) - avg(bottom);
}
