/**
 * lib/retry.mjs - 재시도/백오프 순수 로직 (네트워크 의존 없음, 단위 테스트 대상).
 *
 * 2026-09-30 flow-snapshot 184/422 실패의 원인은 KIS 가 아니라 Supabase Management API 였다.
 * 실패 메시지가 "ThrottlerException: Too Many Requests" 로 KIS 래퍼의 접두사("KIS <tr_id>:")가 없었다.
 * 그래서 DB 호출과 KIS 호출 모두에 같은 백오프 래퍼를 쓴다.
 */

/** 레이트리밋 계열 오류인가. 그 외(파싱 오류, 권한 오류, 잘못된 파라미터)는 false. */
export function isThrottleError(err) {
  const m = String(err?.message ?? err ?? '');
  if (/ThrottlerException|Too Many Requests|\bHTTP 429\b|초당|거래건수|EGW00201|DART 020/i.test(m)) return true;
  // 일시적 네트워크 오류(2026-10-01 DART 백필 중 ECONNRESET 로 프로세스 사망): fetch failed, 리셋, 타임아웃, 5xx
  const code = String(err?.cause?.code ?? err?.code ?? '');
  if (/^(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code)) return true;
  if (/^(TimeoutError|AbortError)$/.test(String(err?.name ?? ''))) return true;
  return /fetch failed|\bHTTP 5\d\d\b/i.test(m);
}

/** 시도 번호(0부터)별 대기 ms. 지수 증가 + 상한. jitter 는 주입 가능(테스트용). */
export function backoffDelay(attempt, { base = 500, max = 15_000, jitter = Math.random } = {}) {
  const d = Math.min(max, base * 2 ** attempt);
  return Math.round(d * (0.75 + 0.5 * jitter()));
}

const realSleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * fn 을 호출하되 throttle 오류만 최대 retries 회 재시도한다.
 * throttle 이 아닌 오류는 즉시 throw (무한 재시도 방지).
 * shouldRetry 로 재시도 대상을 좁힐 수 있다(이미 내부 재시도하는 호출 위에 겹쳐 쓸 때 호출 수 곱셈 방지).
 */
export async function withBackoff(fn, { retries = 5, base = 500, max = 15_000, sleep = realSleep, onRetry = null, jitter, shouldRetry = isThrottleError } = {}) {
  let attempt = 0;
  for (;;) {
    try { return await fn(); }
    catch (e) {
      if (!shouldRetry(e) || attempt >= retries) throw e;
      const wait = backoffDelay(attempt, { base, max, jitter });
      if (onRetry) onRetry(e, attempt + 1, wait);
      await sleep(wait);
      attempt++;
    }
  }
}

/**
 * 항목 목록을 처리하고 실패 항목은 2차 패스(대기 후 재시도)로 다시 돈다.
 * worker(item) 이 throw 하면 실패. 반환 {ok, failed:[{item,error}], passes, rate}.
 */
export async function runWithSecondPass(items, worker, { passes = 2, passPauseMs = 20_000, pace = 0, sleep = realSleep, log = () => {} } = {}) {
  let pending = [...items];
  let okCount = 0;
  const lastErrors = new Map();
  for (let p = 1; p <= passes && pending.length; p++) {
    if (p > 1) { log(`  ${p}차 패스: ${pending.length}건, ${passPauseMs}ms 대기 후 재시도`); await sleep(passPauseMs); }
    const next = [];
    for (const item of pending) {
      try { await worker(item); okCount++; lastErrors.delete(item); }
      catch (e) { next.push(item); lastErrors.set(item, e); }
      if (pace) await sleep(pace);
    }
    log(`  ${p}차 패스 결과: 성공 누적 ${okCount}/${items.length}, 남은 실패 ${next.length}`);
    pending = next;
  }
  return {
    ok: okCount,
    failed: pending.map(item => ({ item, error: String(lastErrors.get(item)?.message ?? '') })),
    passes,
    rate: items.length ? okCount / items.length : 1,
  };
}

/** 'YYYYMMDD' 기간을 days 일 이하 창으로 분할 (DART list.json 은 corp_code 없으면 3개월 제한). */
export function splitWindows(bgn, end, days = 85) {
  const p = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const f = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
  if (!/^\d{8}$/.test(bgn) || !/^\d{8}$/.test(end) || bgn > end) throw new Error(`잘못된 기간 ${bgn}~${end}`);
  const out = [];
  for (let s = p(bgn); s <= p(end); s += days * 86_400_000) out.push([f(s), f(Math.min(s + (days - 1) * 86_400_000, p(end)))]);
  return out;
}

/**
 * 2단계 수집: (A) 항목별 fetch(재시도+2차 패스) -> (B) 성공 항목을 chunk 로 묶어 DB flush(재시도+2차 패스).
 * DB 호출 수를 항목 수가 아니라 chunk 수로 줄이는 것이 목적(Management API 레이트리밋 회피).
 * 반환 rate = 행이 있고 flush 까지 끝난 항목 / 전체. 0행 응답은 empty 로 따로 센다(rateIncludingEmpty 는 참고용).
 */
export async function fetchThenFlush(items, { fetchOne, flushRows, chunkSize = 20, pace = 0, passes = 2, passPauseMs = 20_000, sleep = realSleep, log = () => {} }) {
  const results = new Map();
  const a = await runWithSecondPass(items, async (it) => { results.set(it, await fetchOne(it)); }, { passes, passPauseMs, pace, sleep, log });
  const got = items.filter(it => results.has(it));
  // 응답은 왔지만 0행인 항목은 '성공'이 아니다. 별도 집계(empty)하고 flush 대상에서 뺀다.
  const emptyItems = got.filter(it => results.get(it).length === 0);
  const fetched = got.filter(it => results.get(it).length > 0);
  const chunks = [];
  for (let i = 0; i < fetched.length; i += chunkSize) chunks.push(fetched.slice(i, i + chunkSize));
  let flushedItems = 0, rowsFlushed = 0;
  const b = await runWithSecondPass(chunks, async (chunk) => {
    const rows = chunk.flatMap(it => results.get(it));
    if (rows.length) await flushRows(rows);
    flushedItems += chunk.length; rowsFlushed += rows.length;
  }, { passes: 3, passPauseMs: Math.min(passPauseMs, 15_000), sleep, log });
  const failedFlush = b.failed.flatMap(f => f.item.map(it => ({ item: it, error: `flush: ${f.error}` })));
  const failed = [...a.failed, ...failedFlush];
  const n = items.length;
  return { total: n, fetched: fetched.length, empty: emptyItems.length, emptyItems, flushed: flushedItems, rows: rowsFlushed, failed,
    rate: n ? flushedItems / n : 1,                                  // 엄격: 행이 1개 이상 저장된 항목만
    rateIncludingEmpty: n ? (flushedItems + emptyItems.length) / n : 1 };
}

/** Supabase Management API 쿼리 + throttle 백오프. 오류 응답({message})은 throw. */
export function makeDbQuery({ ref, key, fetchImpl = fetch, timeoutMs = 60_000, retries = 6, sleep = realSleep }) {
  return (sql) => withBackoff(async () => {
    const r = await fetchImpl(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }), signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error(String(j?.message ?? `DB 쿼리 오류 HTTP ${r.status}`));
    return j;
  }, { retries, base: 1000, max: 20_000, sleep });
}
