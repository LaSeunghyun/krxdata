import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const root = process.cwd();
const cacheCodes = new Set();
const rl = createInterface({
  input: createReadStream(join(root, 'candles-daily.jsonl')),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (!line.trim()) continue;
  try {
    const row = JSON.parse(line);
    if (row?.code) cacheCodes.add(row.code);
  } catch {
    // Ignore malformed cache lines; the backtest loader has the same tolerance.
  }
}

const originalFetch = globalThis.fetch;
const allowedHost = 'api.supabase.com';
const droppedCodes = new Set();

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url;
  const parsed = new URL(url);
  if (parsed.hostname !== allowedHost) {
    throw new Error(`cache-only guard blocked non-Supabase fetch: ${parsed.hostname}`);
  }

  const response = await originalFetch(input, init);
  let sql = '';
  try {
    sql = JSON.parse(init?.body ?? '{}')?.query ?? '';
  } catch {
    sql = '';
  }

  if (/FROM\s+stock_analysis/i.test(sql) && /current_price\s*>\s*0/i.test(sql)) {
    const data = await response.json();
    if (!Array.isArray(data)) return new Response(JSON.stringify(data), response);
    const filtered = data.filter(row => {
      const keep = cacheCodes.has(row.stock_code);
      if (!keep) droppedCodes.add(row.stock_code);
      return keep;
    });
    return new Response(JSON.stringify(filtered), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  return response;
};

process.on('exit', () => {
  if (droppedCodes.size) {
    console.error(`[cache-only] filtered missing candle codes: ${[...droppedCodes].sort().join(',')}`);
  }
});
