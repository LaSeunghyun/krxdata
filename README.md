# KRXDATA — 국내 주식 저평가 스코어링 시스템

KOSPI·KOSDAQ 전 종목 재무 데이터를 수집해 섹터 대비 저평가 점수를 산정하고, 매일 자동으로 순위를 갱신하는 파이프라인입니다.

## 아키텍처

```
공공데이터포털 API  ──►  daily-ranking.js  ──►  Supabase DB
OpenDart API      ──►  (GitHub Actions)        daily_rankings 테이블
                                                      │
                                                      ▼
                                          Claude에게 질문
                                          "저평가 종목 추천해줘"
```

## 저평가 점수 계산식 (v6)

```
undervalue_score =
  PBR 섹터 할인 (max 10) + PER 섹터 할인 (max 5)     ← 가치 (v6: PIT 백테스트 역방향 증거로 비중 절반)
  + 가격 모멘텀 60일 (max 15)                        ← v6 신설 (백테스트 IC 양수)
  + PCR 현금흐름수익률 (max 10) + ROE (max 15)
  + 영업이익률 (max 10) + 이익추세 (max 15) + 이익YoY (max 15)
  + 이익안정성 (max 5)
  − 부채비율 페널티 (max 15) − 이자보상배율 페널티 (max 10)
  × 지주사 Soft Penalty (0.6)
```

v6 변경: 52주 위치 >70% 제외 필터 삭제(안티모멘텀), 점수 기반 목표가 제거(미검증 휴리스틱).

데이터 소스: `stock_financials`(연간 `report_code='11011'`) + `sector_stats` + `stock_analysis` + `stock_prices` (Supabase)

## 자동화 스케줄 (GitHub Actions)

| 시각 (KST) | 실행 내용 |
|-----------|---------|
| 월~금 08:00 | 공공데이터 API로 전 종목 현재가 갱신 + 저평가 순위 재계산 |
| 월~금 09:03 | 현재가 생략, 저평가 순위만 재계산 (~5초) |

워크플로우 파일: `.github/workflows/daily-ranking.yml`

**수동 실행**: GitHub Actions 탭 → "KRXDATA Daily Ranking Update" → Run workflow

## DB 테이블

| 테이블 | 내용 |
|--------|------|
| `stock_analysis` | 종목 기본 정보 + 현재가 + 시총 |
| `stock_financials` | 연간 재무제표 (PBR, PER, ROE, 영업이익률, 부채비율) |
| `sector_stats` | 섹터별 평균 PBR, PER, ROE |
| `daily_rankings` | 일자별 저평가 순위 (UNIQUE: rank_date + stock_code) |
| `rank_changes` | 전일 대비 순위·점수·가격 변동 VIEW |

## 주요 스크립트

| 파일 | 역할 |
|------|------|
| `daily-ranking.js` | 현재가 업데이트 + 저평가 순위 계산 + 변동 리포트 + 포트폴리오 알림 (GitHub Actions 진입점) |
| `backtest-pit.mjs` | Point-in-Time 백테스트 — `rcept_dt <= T` 재무만 사용, `--save-ic`로 IC 이력 적재 |
| `rcept-backfill.js` | DART rcept_no → 연간 재무 공시일(`rcept_dt`) 백필 (`--db`로 전체 유니버스) |
| `dart-quarterly-backfill.js` | 분기/반기 재무 적재 — 어닝모멘텀 팩터 데이터 |
| `portfolio.js` | 포트폴리오 원장 — enter/check/close/report, 스톱로스 -25%·절반익절 +100% |
| `run-migration.mjs` | SQL 마이그레이션 실행기 (`node run-migration.mjs migration-v6.sql`) |
| `score-kospi-full.js` | KOSPI 전 종목 스코어링 JSON 생성 |
| `score-kosdaq.js` | KOSDAQ 전 종목 스코어링 JSON 생성 |
| `db-upsert.js` | 점수 JSON을 Supabase `stock_analysis`에 upsert |
| `fetch-sectors.js` | 섹터별 평균 지표 계산 → `sector_stats` 갱신 |
| `batch.js` | 관심 종목 주가·공시 로컬 SQLite 저장 |
| `mcp-server.js` | Claude Desktop MCP 서버 (공시·재무·주가 도구) |

## 분기 운영 절차 (Loop B — 팩터 모니터링)

1. 분기보고서 공시 후: `node dart-quarterly-backfill.js --periods <YYYY:reprt_code>`
2. `node rcept-backfill.js --db --years <최근연도>` (신규 공시 rcept_dt 갱신)
3. `node backtest-pit.mjs --save-ic` → `factor_ic_history` 누적 → IC 추세로 `config.js FACTOR_WEIGHTS` 재가중
   (규칙: `w = clamp(round(mean(IC20, IC60), 2), ±0.2)`, `|w|<0.01 → 0`)

## 환경 변수

```env
DART_API_KEY=
PUBLIC_DATA_API_KEY=
SUPABASE_URL=
SUPABASE_KEY=
SUPABASE_MANAGEMENT_KEY=
SUPABASE_PROJECT_REF=
```

GitHub Actions에서는 Repository Secrets로 관리됩니다.  
로컬 실행 시 `.env` 파일 사용 (`.env.example` 참고).

## 로컬 실행

```bash
npm ci

# 순위만 재계산 (빠름, ~5초)
node daily-ranking.js --skip-price

# 가격 업데이트 + 순위 재계산 (전체, ~30분)
node daily-ranking.js
```

## 조회 방법

GitHub Actions로 `daily_rankings`가 갱신되면 Claude에게 직접 질문:

- `"저평가 종목 TOP 10 추천해줘"` → DB 조회 + 뉴스 + 의견 자동 제공
- `"코스피 저평가 우량주 5개 알려줘"`
- `"삼성전자 분석해줘"`

## MCP 서버 (Claude Desktop)

```json
{
  "mcpServers": {
    "dart-mcp": {
      "command": "node",
      "args": ["C:\\claudeT\\files\\mcp-server.js"],
      "env": {
        "SUPABASE_MANAGEMENT_KEY": "your_supabase_management_key",
        "SUPABASE_PROJECT_REF": "your_supabase_project_ref"
      }
    }
  }
}
```

제공 도구: `get_stock_info`, `search_stocks`, `get_rankings`, `get_sector_stats`

## 데이터 산출물

`dart-data.db`, `scored-*.json`, `profitable-stocks.json`, `*.cache.json` 등은 실행 산출물로 `.gitignore`에 포함됩니다.
