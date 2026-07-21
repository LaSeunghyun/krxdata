/**
 * forecast-disclosures.mjs — OpenDART 당일·전일 공시 수집 (예측 브리핑용)
 * 기존 stock_disclosures는 스코어링 배치에서만 갱신돼 stale — pre/close 실행이 직접 당겨온다.
 * DART list.json: rcept_dt는 YYYYMMDD로 오지만 DB는 'YYYY-MM-DD' — 변환 필수.
 * env: DART_API_KEY
 */
const dash = (d8) => `${d8.slice(0, 4)}-${d8.slice(4, 6)}-${d8.slice(6, 8)}`;

export async function collectRecentDisclosures({ dbQuery, todayKey, days = 2, log = () => {} }) {
  const key = process.env.DART_API_KEY;
  if (!key) return { scanned: 0, matched: 0, note: 'DART_API_KEY 없음' };
  const d = new Date(`${dash(todayKey)}T12:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  const bgn = d.toISOString().slice(0, 10).replace(/-/g, '');

  const uni = new Set((await dbQuery(`SELECT stock_code FROM stock_analysis`)).map(r => r.stock_code));
  const rows = [];
  let scanned = 0;
  for (let page = 1; page <= 40; page++) {
    const u = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${key}&bgn_de=${bgn}&end_de=${todayKey}&page_no=${page}&page_count=100`;
    const j = await (await fetch(u, { signal: AbortSignal.timeout(20_000) })).json();
    if (j.status === '013') break; // 조회 데이터 없음
    if (j.status !== '000') throw new Error(`DART list: ${j.status} ${j.message}`);
    for (const it of j.list ?? []) {
      scanned += 1;
      if (it.stock_code && uni.has(it.stock_code)) {
        rows.push({ code: it.stock_code, rcept_no: it.rcept_no, dt: dash(it.rcept_dt), nm: String(it.report_nm ?? '').slice(0, 300) });
      }
    }
    if (page >= Number(j.total_page ?? 1)) break;
  }
  const esc = (s) => `'${String(s).replace(/'/g, "''")}'`;
  for (let i = 0; i < rows.length; i += 500) {
    const vals = rows.slice(i, i + 500)
      .map(r => `(${esc(r.code)}, ${esc(r.rcept_no)}, ${esc(r.dt)}, ${esc(r.nm)})`).join(',');
    await dbQuery(`
      INSERT INTO stock_disclosures (stock_code, rcept_no, rcept_dt, report_nm)
      VALUES ${vals} ON CONFLICT (rcept_no) DO NOTHING`);
  }
  log(`공시 수집: 전체 ${scanned}건 스캔 → 유니버스 매칭 ${rows.length}건 upsert (${bgn}~${todayKey})`);
  return { scanned, matched: rows.length };
}
