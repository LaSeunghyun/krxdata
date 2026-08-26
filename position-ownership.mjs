/**
 * position-ownership.mjs — 보유 포지션의 소유권 판정 (봇이 산 것인가, 사용자가 산 것인가).
 *
 * 배경(2026-08-26): 사용자가 토스 앱에서 직접 산 에이치브이엠(295310)이 AI 청산예약으로
 *   3회 강제청산됐다. `sub 미상` 은 두 가지를 동시에 뜻한다 —
 *     ① 사용자가 산 것  ② 봇이 샀는데 meta 를 잃은 것(크래시·부분체결·meta purge)
 *   ②를 격리하면 검증된 -15% 손절이 조용히 사라진다. 그래서 저널(BUY 레코드에 `sub` 포함,
 *   원자쓰기+.bak 이라 state 보다 견고)을 독립 오라클로 써서 둘을 가른다.
 *
 * 이 모듈에 순수함수만 두는 이유: stock-live.mjs 는 top-level await·무한루프가 있어 import 가
 *   불가능하다(두 번째 트레이더가 뜬다). 인라인이면 소스 정규식 대조밖에 못 하는데, 이번 결함이
 *   정확히 "소스에는 있는데 실행 경로가 아니었다" 유형이다.
 */

/**
 * 저널 기준 봇 보유수량 = BUY qty 합 − SELL qty 합.
 * 음수(SELL > BUY)는 클램프하지 않는다 — 데이터 이상이므로 호출부가 user 로 떨어뜨리게 둔다.
 */
export function botHeldQty(trades, code) {
  let q = 0;
  for (const t of trades) {
    if (String(t?.code) !== String(code)) continue;
    const n = Number(t?.qty);
    if (!Number.isFinite(n)) continue;
    if (t.side === 'BUY') q += n;
    else if (t.side === 'SELL') q -= n;
  }
  return q;
}

/** 저널에서 이 종목의 마지막 BUY 레코드 (복원 meta 의 원천). */
function lastBuy(trades, code) {
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (String(t?.code) === String(code) && t.side === 'BUY') return t;
  }
  return null;
}

/**
 * @returns {{kind:'bot'|'user'|'unknown', why:string, restoreMeta?:object}}
 *   'unknown' = 저널을 읽을 수 없어 판정 보류. 호출부는 아무 조치도 하지 않는다.
 */
export function classifyPosition({ code, brokerQty, currentPx, meta, trades }) {
  if (meta?.sub) return { kind: 'bot', why: `meta.sub=${meta.sub} — 이미 봇이 관리 중` };
  if (!Array.isArray(trades)) return { kind: 'unknown', why: '저널을 읽을 수 없다 — 판정 보류' };

  const bq = botHeldQty(trades, code);
  const bk = Number(brokerQty);
  if (bq > 0 && Number.isFinite(bk) && bq >= bk) {
    const lb = lastBuy(trades, code);
    if (lb?.sub) {
      // ★ Number(v) > 0 는 Infinity 를 통과시킨다. hi=Infinity 면 트레일 판정
      //   `close <= hi * (1 - trailPct/100)` 이 **항상 참**이 되어 포지션이 즉시 강제청산된다
      //   (entry=Infinity 면 하드손절도 마찬가지). 숫자상 hi>=entry 는 지켜지지만 안전 방향이
      //   정반대로 뒤집히므로 유한값만 받는다.
      const finite = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
      const px = finite(currentPx);
      const entry = finite(lb.px) || px;
      return {
        kind: 'bot',
        why: `저널 봇잔량 ${bq} >= 보유 ${bk} — meta 복원`,
        // hi 를 진입가 이상으로만 잡는다: 진입 후 실제 고점을 모른다. 낮게 잡으면 트레일이
        //   늦게 걸린다 = 덜 파는 쪽 = 안전측.
        restoreMeta: { sub: lb.sub, boughtAt: lb.ts, entry, hi: Math.max(entry, px) },
      };
    }
    return { kind: 'user', why: '저널 BUY 에 sub 가 없어 복원할 전략이 없다' };
  }
  return {
    kind: 'user',
    why: bq <= 0 ? '저널에 봇 매수 기록이 없다' : `저널 봇잔량 ${bq} < 보유 ${bk} — 사용자 추가매수`,
  };
}
