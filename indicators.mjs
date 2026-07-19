/**
 * indicators.mjs — 표준 기술적 지표 라이브러리 (일봉 close/high/low/volume 배열 입력)
 *   목표별 익절/손절가 산출과 다지표 컨플루언스 스코어링에 사용. 전부 PIT(인덱스 i까지만).
 */

export function sma(c, i, n) {
  if (i < n - 1) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) s += c[j];
  return s / n;
}

export function ema(c, i, n) {
  if (i < n - 1) return null;
  const k = 2 / (n + 1);
  let e = sma(c, n - 1, n); // seed = 첫 SMA
  for (let j = n; j <= i; j++) e = c[j] * k + e * (1 - k);
  return e;
}

export function rsi(c, i, n = 14) {
  if (i < n) return null;
  let gain = 0, loss = 0;
  for (let j = i - n + 1; j <= i; j++) {
    const ch = c[j] - c[j - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  const rs = loss === 0 ? Infinity : gain / loss;
  return 100 - 100 / (1 + rs);
}

export function bollinger(c, i, n = 20, k = 2) {
  const m = sma(c, i, n);
  if (m == null) return null;
  let sq = 0;
  for (let j = i - n + 1; j <= i; j++) sq += (c[j] - m) ** 2;
  const sd = Math.sqrt(sq / n);
  return { mid: m, upper: m + k * sd, lower: m - k * sd, sd, bandwidth: (2 * k * sd) / m, pctB: sd > 0 ? (c[i] - (m - k * sd)) / (2 * k * sd) : 0.5 };
}

export function macd(c, i, fast = 12, slow = 26, sig = 9) {
  if (i < slow + sig) return null;
  const line = [];
  for (let j = slow - 1; j <= i; j++) {
    const ef = ema(c, j, fast), es = ema(c, j, slow);
    if (ef == null || es == null) return null;
    line.push(ef - es);
  }
  // signal = EMA(sig) of macd line
  const k = 2 / (sig + 1);
  let s = line.slice(0, sig).reduce((a, b) => a + b, 0) / sig;
  for (let j = sig; j < line.length; j++) s = line[j] * k + s * (1 - k);
  const cur = line[line.length - 1];
  return { macd: cur, signal: s, hist: cur - s };
}

export function atr(high, low, close, i, n = 14) {
  if (i < n) return null;
  let tr = 0;
  for (let j = i - n + 1; j <= i; j++) {
    tr += Math.max(high[j] - low[j], Math.abs(high[j] - close[j - 1]), Math.abs(low[j] - close[j - 1]));
  }
  return tr / n;
}

export function volRatio(vol, i, n = 20) {
  if (i < n) return null;
  let av = 0;
  for (let j = i - n; j < i; j++) av += vol[j];
  av /= n;
  return av > 0 ? vol[i] / av : null;
}

export function highest(high, i, n) {
  if (i < n) return null;
  let h = 0;
  for (let j = i - n + 1; j <= i; j++) h = Math.max(h, high[j]);
  return h;
}
export function lowest(low, i, n) {
  if (i < n) return null;
  let l = Infinity;
  for (let j = i - n + 1; j <= i; j++) l = Math.min(l, low[j]);
  return l;
}

/**
 * 다지표 컨플루언스 스코어 (0~100) + 근거 배열 + 종목별 익절/손절가.
 *   c/h/l/v: 오름차순 배열, i: 현재 인덱스(당일 종가 확정).
 *   반환: { score, signals:[근거...], entry, stop, target, rr } | null(데이터 부족)
 */
export function scoreSignal(c, h, l, v, i) {
  if (i < 60) return null;
  const price = c[i];
  const ma5 = sma(c, i, 5), ma20 = sma(c, i, 20), ma60 = sma(c, i, 60);
  const rsiV = rsi(c, i, 14);
  const bb = bollinger(c, i, 20, 2);
  const mac = macd(c, i);
  const atrV = atr(h, l, c, i, 14);
  const vr = volRatio(v, i, 20);
  if (ma5 == null || ma20 == null || ma60 == null || rsiV == null || bb == null || atrV == null) return null;

  let score = 0;
  const sig = [];
  // 1) 이평선 정배열 (25) — 추세 방향
  if (price > ma5 && ma5 > ma20 && ma20 > ma60) { score += 25; sig.push('MA정배열(가격>5>20>60)'); }
  else if (price > ma20 && ma20 > ma60) { score += 15; sig.push('MA중기상승(가격>20>60)'); }
  else if (price > ma60) { score += 7; sig.push('MA장기추세유지(가격>60)'); }
  // 2) 볼린저 위치 (20) — 과열/눌림
  if (bb.pctB >= 0.5 && bb.pctB <= 0.8) { score += 20; sig.push(`볼린저 중상단(%B ${bb.pctB.toFixed(2)})`); }
  else if (bb.pctB > 0.8 && bb.pctB <= 1.0) { score += 10; sig.push(`볼린저 상단접근(%B ${bb.pctB.toFixed(2)})`); }
  else if (bb.pctB >= 0.2 && bb.pctB < 0.5) { score += 12; sig.push(`볼린저 중하단 눌림(%B ${bb.pctB.toFixed(2)})`); }
  // 3) RSI (20) — 모멘텀 (과매수 회피, 중립~상승 선호)
  if (rsiV >= 50 && rsiV <= 65) { score += 20; sig.push(`RSI 상승구간(${rsiV.toFixed(0)})`); }
  else if (rsiV > 65 && rsiV <= 75) { score += 8; sig.push(`RSI 다소과열(${rsiV.toFixed(0)})`); }
  else if (rsiV >= 40 && rsiV < 50) { score += 12; sig.push(`RSI 중립반등(${rsiV.toFixed(0)})`); }
  // 4) MACD (20) — 추세 전환/유지
  if (mac) {
    if (mac.hist > 0 && mac.macd > 0) { score += 20; sig.push('MACD 양전+상승'); }
    else if (mac.hist > 0) { score += 12; sig.push('MACD 히스토그램 상승전환'); }
    else if (mac.macd > mac.signal) { score += 6; sig.push('MACD 골든근접'); }
  }
  // 5) 거래량 (15) — 신호 확인
  if (vr != null) {
    if (vr >= 1.5 && vr <= 4) { score += 15; sig.push(`거래량 동반(${vr.toFixed(1)}x)`); }
    else if (vr > 4) { score += 5; sig.push(`거래량 급증 과열주의(${vr.toFixed(1)}x)`); }
    else if (vr >= 1.0) { score += 8; sig.push(`거래량 평이(${vr.toFixed(1)}x)`); }
  }

  // 익절/손절: ATR 기반 손절(하방 스윙저 or entry-2×ATR 중 높은쪽) + 볼린저 상단/저항 목표
  const swingLow = lowest(l, i, 10);
  const atrStop = price - 2 * atrV;
  const stop = Math.max(atrStop, swingLow ?? atrStop);
  const risk = price - stop;
  // 목표: 볼린저 상단과 (entry + 2R) 중 보수적으로 가까운 쪽, 단 최소 +2R 확보
  const bbTarget = bb.upper;
  const rrTarget = price + 2 * risk;
  const target = Math.max(rrTarget, Math.min(bbTarget, price + 3 * risk));
  const rr = risk > 0 ? (target - price) / risk : 0;

  return {
    score, signals: sig, entry: price, stop, target,
    stopPct: ((price - stop) / price * 100),
    targetPct: ((target - price) / price * 100),
    rr, atr: atrV, rsi: rsiV, pctB: bb.pctB, ma20, ma60,
  };
}
