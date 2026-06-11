/**
 * dart-mcp/mcp-server.js  v3.0
 *
 * 데이터 소스: Supabase DB 단일화
 *   - stock_analysis   : 종목 기본정보, 현재가, 52주 고저가
 *   - stock_financials : 재무 지표 (pbr, per, roe, op_margin, debt_ratio 등)
 *   - daily_rankings   : 저평가 스코어 랭킹
 *   - sector_stats     : 섹터 평균 통계
 *
 * Tool 목록:
 *   get_stock_info     종목 기본정보 + 재무 + 현재 랭킹
 *   search_stocks      종목명 검색
 *   get_rankings       저평가 랭킹 조회 (TOP N)
 *   get_sector_stats   섹터별 평균 밸류에이션
 */

import { Server }              from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
import {
  escapeSqlLiteral,
  parseFinancialYear,
  parseMarket,
  parseOptionalSqlText,
  parseRankingLimit,
} from "./mcp-input.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const MGMT_KEY   = process.env.SUPABASE_MANAGEMENT_KEY;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "onxkbuecwbcueuhwnowx";

if (!MGMT_KEY) {
  console.error("[dart-mcp] SUPABASE_MANAGEMENT_KEY 미설정");
  process.exit(1);
}

async function dbQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MGMT_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data?.message ?? "DB 쿼리 오류");
  return data;
}

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// ── Tools 정의 ─────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_stock_info",
    description: "종목코드로 기업 기본정보, 재무지표, 현재 저평가 랭킹을 Supabase DB에서 조회합니다.",
    inputSchema: {
      type: "object",
      properties: {
        stock_code: { type: "string", description: "종목코드 6자리 (예: 005930)" },
        year: { type: "number", description: "재무 기준 연도 (기본 2024)", default: 2024 },
      },
      required: ["stock_code"],
    },
  },
  {
    name: "search_stocks",
    description: "종목명(일부)으로 종목을 검색합니다.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "검색할 종목명 (일부 입력 가능)" },
        market: { type: "string", description: "시장 필터: KOSPI | KOSDAQ (생략 시 전체)" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_rankings",
    description: "저평가 스코어 기준 랭킹 TOP N을 조회합니다. (최신 daily_rankings 기준)",
    inputSchema: {
      type: "object",
      properties: {
        top: { type: "number", description: "상위 N개 (기본 20, 최대 100)", default: 20 },
        sector: { type: "string", description: "섹터 필터 (생략 시 전체, 예: '반도체·전자부품')" },
        market: { type: "string", description: "시장 필터: KOSPI | KOSDAQ (생략 시 전체)" },
      },
    },
  },
  {
    name: "get_sector_stats",
    description: "섹터별 평균 PBR·PER 통계를 조회합니다.",
    inputSchema: {
      type: "object",
      properties: {
        market: { type: "string", description: "시장 필터: KOSPI | KOSDAQ (생략 시 전체)" },
        sector: { type: "string", description: "특정 섹터만 조회 (생략 시 전체)" },
      },
    },
  },
];

// ── 핸들러 ────────────────────────────────────────────────
const server = new Server(
  { name: "dart-mcp", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    // ── get_stock_info ─────────────────────────────────────
    if (name === "get_stock_info") {
      const code = String(args.stock_code ?? "").trim();
      if (!/^\d{6}$/.test(code)) throw new Error("stock_code는 6자리 숫자여야 합니다");
      const year = parseFinancialYear(args.year);

      const rows = await dbQuery(`
        SELECT
          sa.stock_code, sa.corp_name, sa.mrkt_ctg, sa.sector,
          sa.current_price, sa.market_cap_tril,
          sa.high_52w, sa.low_52w,
          sf.pbr, sf.per, sf.roe, sf.op_margin, sf.debt_ratio,
          sf.op_income_yoy, sf.op_income, sf.net_income,
          sf.analysis_year,
          ss.avg_pbr AS sector_avg_pbr,
          ss.avg_per AS sector_avg_per,
          dr.rank, dr.undervalue_score, dr.total_score, dr.rank_date
        FROM stock_analysis sa
        LEFT JOIN stock_financials sf
          ON sa.stock_code = sf.stock_code AND sf.analysis_year = ${year} AND sf.report_code = '11011'
        LEFT JOIN sector_stats ss
          ON sa.sector = ss.sector AND sa.mrkt_ctg = ss.mrkt_ctg
        LEFT JOIN daily_rankings dr
          ON sa.stock_code = dr.stock_code
          AND dr.rank_date = (SELECT MAX(rank_date) FROM daily_rankings)
        WHERE sa.stock_code = '${code}'
        LIMIT 1
      `);

      if (!rows.length) throw new Error(`종목코드 ${code}를 찾을 수 없습니다`);
      const r = rows[0];

      const pos52w = (r.high_52w && r.low_52w && r.high_52w !== r.low_52w)
        ? ((r.current_price - r.low_52w) / (r.high_52w - r.low_52w) * 100).toFixed(1) + "%"
        : "-";

      return ok({
        기본정보: {
          종목코드: r.stock_code,
          종목명: r.corp_name,
          시장: r.mrkt_ctg,
          섹터: r.sector,
          현재가: r.current_price ? r.current_price.toLocaleString("ko-KR") + "원" : "-",
          시총: r.market_cap_tril ? (r.market_cap_tril * 1000).toFixed(0) + "억원" : "-",
          "52주고가": r.high_52w ? r.high_52w.toLocaleString("ko-KR") + "원" : "-",
          "52주저가": r.low_52w ? r.low_52w.toLocaleString("ko-KR") + "원" : "-",
          "52주위치": pos52w,
        },
        재무지표: {
          기준연도: r.analysis_year ?? year,
          PBR: r.pbr ?? "-",
          PER: r.per ?? "-",
          ROE: r.roe ? r.roe + "%" : "-",
          영업이익률: r.op_margin ? r.op_margin + "%" : "-",
          부채비율: r.debt_ratio ? r.debt_ratio + "%" : "-",
          영업이익YoY: r.op_income_yoy ? r.op_income_yoy + "%" : "-",
        },
        섹터비교: {
          섹터평균PBR: r.sector_avg_pbr ?? "-",
          섹터평균PER: r.sector_avg_per ?? "-",
          PBR할인율: (r.pbr && r.sector_avg_pbr)
            ? ((1 - r.pbr / r.sector_avg_pbr) * 100).toFixed(1) + "%" : "-",
        },
        저평가랭킹: {
          랭킹: r.rank ?? "-",
          저평가점수: r.undervalue_score ?? "-",
          기준일: r.rank_date ?? "-",
        },
      });
    }

    // ── search_stocks ──────────────────────────────────────
    if (name === "search_stocks") {
      const q = escapeSqlLiteral(String(args.name ?? "").trim());
      if (!q) throw new Error("name을 입력하세요");
      const market = parseMarket(args.market);
      const marketFilter = market ? `AND sa.mrkt_ctg = '${market}'` : "";

      const rows = await dbQuery(`
        SELECT sa.stock_code, sa.corp_name, sa.mrkt_ctg, sa.sector,
               sa.current_price, sa.market_cap_tril,
               sf.pbr, sf.per, sf.roe,
               dr.rank, dr.undervalue_score
        FROM stock_analysis sa
        LEFT JOIN stock_financials sf
          ON sa.stock_code = sf.stock_code AND sf.analysis_year = 2024 AND sf.report_code = '11011'
        LEFT JOIN daily_rankings dr
          ON sa.stock_code = dr.stock_code
          AND dr.rank_date = (SELECT MAX(rank_date) FROM daily_rankings)
        WHERE sa.corp_name LIKE '%${q}%'
        ${marketFilter}
        ORDER BY sa.market_cap_tril DESC NULLS LAST
        LIMIT 20
      `);

      if (!rows.length) throw new Error(`'${q}' 검색 결과 없음`);
      return ok({ 검색어: q, 결과수: rows.length, 종목목록: rows });
    }

    // ── get_rankings ───────────────────────────────────────
    if (name === "get_rankings") {
      const top = parseRankingLimit(args.top);
      const sector = parseOptionalSqlText(args.sector, "sector");
      const market = parseMarket(args.market);
      const sectorFilter = sector ? `AND dr.sector = '${sector}'` : "";
      const marketFilter = market ? `AND dr.mrkt_ctg = '${market}'` : "";

      const rows = await dbQuery(`
        SELECT rank, stock_code, corp_name, mrkt_ctg, sector,
               current_price, market_cap_tril,
               pbr, per, roe, op_margin,
               undervalue_score, total_score,
               sector_avg_pbr, sector_avg_per
        FROM daily_rankings
        WHERE rank_date = (SELECT MAX(rank_date) FROM daily_rankings)
        ${sectorFilter}
        ${marketFilter}
        ORDER BY rank ASC
        LIMIT ${top}
      `);

      const rankDate = rows[0] ? "최신" : "-";
      return ok({ 기준일: rankDate, 조회건수: rows.length, 랭킹: rows });
    }

    // ── get_sector_stats ───────────────────────────────────
    if (name === "get_sector_stats") {
      const market = parseMarket(args.market);
      const sector = parseOptionalSqlText(args.sector, "sector");
      const marketFilter = market ? `WHERE mrkt_ctg = '${market}'` : "";
      const sectorFilter = sector
        ? (marketFilter ? `AND sector = '${sector}'` : `WHERE sector = '${sector}'`)
        : "";

      const rows = await dbQuery(`
        SELECT sector, mrkt_ctg, avg_pbr, avg_per, stock_count
        FROM sector_stats
        ${marketFilter}
        ${sectorFilter}
        ORDER BY avg_pbr ASC
      `);

      if (!rows.length) throw new Error("섹터 통계 없음");
      return ok({ 섹터수: rows.length, 섹터통계: rows });
    }

    throw new Error(`정의되지 않은 tool: ${name}`);

  } catch (e) {
    return { content: [{ type: "text", text: `오류: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[dart-mcp v3.0] Supabase DB 전용 서버 시작");
