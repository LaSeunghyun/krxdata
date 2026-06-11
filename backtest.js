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

// 한 종목의 재무 행들 중 rcept_dt <= asOf 인 행에서 "가장 최근 회계기간" 선택:
// analysis_year 최대 우선, 동률이면 rcept_dt 최대(같은 연도 내 더 늦은 분기/정정분).
// ※ rcept_dt 최대 우선이면 구연도 정정공시(예: FY2023 정정 6월)가 FY2024 정기공시(3월)를 가린다.
export function latestFinancialAsOf(rows, asOf) {
  if (!Array.isArray(rows)) return null;
  let best = null;
  for (const r of rows) {
    if (r?.rcept_dt == null) continue;
    const d = String(r.rcept_dt);
    if (d > String(asOf)) continue;
    if (
      best === null ||
      (r.analysis_year ?? 0) > (best.analysis_year ?? 0) ||
      ((r.analysis_year ?? 0) === (best.analysis_year ?? 0) && d > String(best.rcept_dt))
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

// 백테스트 펀더멘털 팩터 (높을수록 좋음 방향 통일).
// fin = PIT 선택된 연간 재무 행(DB row). value는 stale per/pbr 대신
// T 시점 시총(mcapT)으로 earnings/book yield를 직접 계산해 PIT 정합 유지.
// 결측·자본잠식·적자·mcapT 불명은 null(중립) — 절대 NaN/Infinity 미반환.
export function fundamentalFactors(fin, mcapT) {
  if (!fin) return { value: null, quality: null, growth: null };
  const ni = Number(fin.net_income), eq = Number(fin.total_equity);
  const ey = Number.isFinite(ni) && ni > 0 && mcapT > 0 ? ni / mcapT : null; // earnings yield (적자 결측)
  const by = Number.isFinite(eq) && eq > 0 && mcapT > 0 ? eq / mcapT : null; // book yield (자본잠식 결측)
  const value = ey != null && by != null ? (ey + by) / 2 : (ey ?? by);
  // quality: roe↑, debt_ratio↓, cur_ratio↑, cf_ops>0
  const roe = Number.isFinite(Number(fin.roe)) ? Number(fin.roe) : null;
  const debtPenalty = Number.isFinite(Number(fin.debt_ratio)) ? -Number(fin.debt_ratio) : null;
  const cur = Number.isFinite(Number(fin.cur_ratio)) ? Number(fin.cur_ratio) : null;
  const cf = Number.isFinite(Number(fin.cf_ops)) ? (Number(fin.cf_ops) > 0 ? 1 : 0) : null;
  const qParts = [roe, debtPenalty, cur, cf == null ? null : cf * 100].filter((v) => v != null);
  const quality = qParts.length ? qParts.reduce((a, b) => a + b, 0) / qParts.length : null;
  // growth: revenue_yoy, op_income_yoy
  const rg = Number.isFinite(Number(fin.revenue_yoy)) ? Number(fin.revenue_yoy) : null;
  const og = Number.isFinite(Number(fin.op_income_yoy)) ? Number(fin.op_income_yoy) : null;
  const gParts = [rg, og].filter((v) => v != null);
  const growth = gParts.length ? gParts.reduce((a, b) => a + b, 0) / gParts.length : null;
  return { value, quality, growth };
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
