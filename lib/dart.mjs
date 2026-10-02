/**
 * lib/dart.mjs - OpenDART 호출 헬퍼 (백오프 포함). status 020(요청 제한)은 throttle 로 취급해 재시도한다.
 * status 000 정상, 013 조회 데이터 없음(빈 배열로 취급), 그 외는 throw.
 */
import { withBackoff } from './retry.mjs';

const BASE = 'https://opendart.fss.or.kr/api';

export async function dartGet(endpoint, params, { key = process.env.DART_API_KEY } = {}) {
  if (!key) throw new Error('DART_API_KEY 미설정');
  return withBackoff(async () => {
    const q = new URLSearchParams({ crtfc_key: key, ...params });
    const res = await fetch(`${BASE}/${endpoint}.json?${q}`, { signal: AbortSignal.timeout(30_000) });
    let j;
    try { j = await res.json(); } catch { throw new Error(`DART ${endpoint}: 비JSON 응답 HTTP ${res.status}`); }
    if (j.status === '013') return { status: '013', list: [], total_page: 0 };
    if (j.status !== '000') throw new Error(`DART ${j.status} ${endpoint}: ${j.message ?? ''}`);
    return j;
  }, { retries: 5, base: 1500, max: 30_000 });
}

/** list.json 전 페이지. 반환 [{corp_code, corp_name, stock_code, report_nm, rcept_no, rcept_dt}] */
export async function listAll({ bgn, end, ty, pace = 120, onPage = null, concurrency = 4 }) {
  const get = (page) => dartGet('list', { bgn_de: bgn, end_de: end, pblntf_ty: ty, page_no: String(page), page_count: '100' });
  const first = await get(1);
  const total = Number(first.total_page) || 0;
  const pages = new Map([[1, first.list ?? []]]);
  if (onPage) onPage(1, total);
  let next = 2;
  // 페이지 호출이 건당 수 초라 소수의 워커로 병렬화 (DART 한도 분당 ~1000건 대비 충분히 낮음)
  const worker = async () => {
    while (next <= total) {
      const p = next++;
      const j = await get(p);
      pages.set(p, j.list ?? []);
      if (onPage) onPage(p, total);
      if (pace) await new Promise(r => setTimeout(r, pace));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(0, total - 1)) }, worker));
  const out = [];
  for (let p = 1; p <= total; p++) out.push(...(pages.get(p) ?? []));
  return out;
}
