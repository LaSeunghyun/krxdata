// Bun이 현재 디렉터리의 .env를 자동 로드함
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ files/.env 에 SUPABASE_URL, SUPABASE_SERVICE_KEY 를 설정하세요');
  process.exit(1);
}

const raw = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'scored-stocks.json'), 'utf8')
);

const rows = raw.results.map(s => ({
  stock_code:         s.stockCode,
  corp_name:          s.corp_name,
  current_price:      s.currentPrice       ?? null,
  short_target_price: s.shortTargetPrice   ?? null,
  mid_target_price:   s.midTargetPrice     ?? null,
  short_target_pct:   s.shortTargetPct     ?? null,
  mid_target_pct:     s.midTargetPct       ?? null,
  recommendation:     s.recommendation     ?? null,
  market_cap_tril:    s.marketCapTril      ?? null,
  total_score:        s.totalScore         ?? null,
  short_score:        s.shortScore         ?? null,
  long_score:         s.longScore          ?? null,
  mrkt_ctg:           s.mrktCtg            ?? null,
  detail:             s.detail             ?? null,
  generated_at:       raw.generatedAt,
}));

console.log(`📤 ${rows.length}개 종목 upsert 시작...`);

const res = await fetch(`${SUPABASE_URL}/rest/v1/stock_analysis`, {
  method: 'POST',
  headers: {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Prefer':        'resolution=merge-duplicates',
  },
  body: JSON.stringify(rows),
});

if (!res.ok) {
  const err = await res.text();
  console.error('❌ Push 실패:', res.status, err);
  process.exit(1);
}

console.log(`✅ ${rows.length}개 종목 Supabase upsert 완료`);
console.log(`   generatedAt: ${raw.generatedAt}`);
