// 공유 판정 유틸 — validate-hypotheses.mjs(VM 일일 크론)와 autoresearch 러너가 함께 쓴다.
// 순수 함수만 둔다. spawn·파일IO·전역상수는 호출자가 주입한다(테스트 가능성 확보).
// 2026-08-21 신설: validate-hypotheses.mjs 는 top-level IIFE + export 없음이라 재사용 불가였고,
//   휴장일에 exit 0 으로 즉시 종료해 직접 spawn 하면 조용히 아무것도 안 돈다.

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// ★ override(변형)를 앞에 둔다. backtest-swing.mjs 의 argOf 는 argv.indexOf = 첫 출현만 읽으므로
//   뒤에 붙이면 base 의 동일 플래그가 이겨 변형이 조용히 무효화된다(방법론 §3).
//
// drop 토큰: prepend 로는 base 의 **presence 플래그**(--skipneutralrsi 등)를 끌 수 없다.
//   base 가 라이브 계약을 담게 되면서(2026-08-22) "그 기능을 끈 arm" 을 표현할 방법이 필요해졌다.
//   `__DROP:--flag` 로 base 에서 뺀다. 값이 붙는 플래그면 값까지 같이 뺀다.
//   `__DROP_LIVE_PARITY__` 는 기존 호환용 별칭이다.
export function mergeArgs(override, base) {
  const isDrop = (a) => typeof a === 'string' && a.startsWith('__DROP');
  const drops = override.filter(isDrop);
  if (!drops.length) return [...override, ...base];

  const flags = new Set(drops.map(d => (d === '__DROP_LIVE_PARITY__' ? '--live-parity' : d.slice('__DROP:'.length))));
  const kept = [];
  for (let i = 0; i < base.length; i++) {
    if (flags.has(base[i])) {
      // 다음 토큰이 플래그가 아니면 이 플래그의 값이다 — 같이 뺀다(안 빼면 고아 값이 argv 를 밀어낸다).
      if (i + 1 < base.length && !String(base[i + 1]).startsWith('--')) i++;
      continue;
    }
    kept.push(base[i]);
  }
  return [...override.filter(a => !isDrop(a)), ...kept];
}

export function parseComboRow(out) {
  const line = out.split('\n').find(l => /^combo-v2\s/.test(l));
  if (!line) return null;
  const pcts = [...line.matchAll(/([0-9.]+)%/g)].map(m => Number(m[1]));  // [win, cagr, mdd, month]
  const fin = [...line.matchAll(/([0-9,]+)원/g)].map(m => Number(m[1].replace(/,/g, '')));
  return { cagr: pcts[1] ?? null, mdd: pcts[2] ?? null, final: fin[fin.length - 1] ?? null };
}

// Calmar = CAGR / MDD. 노이즈 바닥이 ΔCalmar 단위로 정의돼 있어(방법론 §1) 주지표로 쓴다.
export function calmar(cagr, mdd) {
  if (cagr == null || mdd == null || !(mdd > 0)) return null;
  return cagr / mdd;
}

// 한 변형의 MC 중앙값. runBacktest: (args) => {cagr,mdd,final}|null 을 주입받는다.
// n < seeds 면 죽은 시드가 있다는 뜻 — 호출자가 판정 전에 확인해야 한다(방법론 §1-F).
export function mcMedian(overrideArgs, { base, seeds, runBacktest, subsample = 0.8 }) {
  const merged = mergeArgs(overrideArgs, base);
  const finals = [], cagrs = [], mdds = [], calmars = [];
  for (let s = 1; s <= seeds; s++) {
    const row = runBacktest([...merged, '--seed', String(s), '--subsample', String(subsample)]);
    if (row?.final != null) {
      finals.push(row.final);
      cagrs.push(row.cagr);
      mdds.push(row.mdd);
      const c = calmar(row.cagr, row.mdd);
      if (c != null) calmars.push(c);
    }
  }
  return {
    medianFinal: median(finals),
    medianCagr: median(cagrs),
    medianMdd: median(mdds),
    medianCalmar: median(calmars),
    n: finals.length,
    seeds,
  };
}
