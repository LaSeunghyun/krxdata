# dart-mcp

OpenDart, 공공데이터포털 주식 데이터, 네이버 금융 시세, 로컬 SQLite, Supabase를 연결한 국내 주식 분석 작업공간입니다. Claude Desktop MCP 서버로도 실행할 수 있고, 배치/스코어링 스크립트로 로컬 산출물을 만들 수도 있습니다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `mcp-server.js` | Claude MCP 서버. 공시, 재무, 주가, 로컬 DB 조회 도구를 제공합니다. |
| `batch.js` | `watchlist.json` 기준으로 최근 주가와 공시 목록을 `dart-data.db`에 저장합니다. |
| `db.js` | SQLite DB 생성과 테이블 초기화를 담당합니다. |
| `score-kospi-full.js` | KOSPI 흑자 기업 전체를 점수화해 `scored-kospi-full.json`을 만듭니다. |
| `score-kosdaq.js` | KOSDAQ 흑자 기업 전체를 점수화해 `scored-kosdaq.json`을 만듭니다. |
| `score-top100.js` | 영업이익 상위 100개 기업을 점수화해 `scored-stocks.json`을 만듭니다. |
| `stock-utils.js` | 목표가 계산과 추천 문구 생성 공통 로직입니다. |
| `db-upsert.js` | 점수 산출물을 Supabase `stock_analysis` 테이블에 upsert합니다. |
| `config.js` | 분석 연도, 배치 크기, 지연 시간, 타임아웃 기본값을 중앙 관리합니다. |

## 설치

```powershell
cd C:\claudeT\files
npm ci
Copy-Item .env.example .env
```

`.env`에 API 키를 입력합니다.

| 환경변수 | 설명 |
| --- | --- |
| `DART_API_KEY` | OpenDart API 키 |
| `PUBLIC_DATA_API_KEY` | 공공데이터포털 Encoding 인증키 |
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `ANALYSIS_YEAR` | 기본 사업보고서 연도. 기본값 `2025` |
| `ANALYSIS_YEAR_FALLBACK` | 기본 연도 데이터가 없을 때 조회할 연도. 기본값 `2024` |
| `SCORE_BATCH_SIZE` | DART 다중 재무 조회 배치 크기. 기본값 `100` |
| `SCORE_DELAY_MS` | 스코어링 루프 지연 시간. 기본값 `300` |
| `TOP_STOCK_LIMIT` | `score:top100` 대상 수. 기본값 `100` |

## 주요 명령

```powershell
npm.cmd run check
npm.cmd test
npm.cmd start
npm.cmd run batch
npm.cmd run score:kospi
npm.cmd run score:kosdaq
npm.cmd run score:top100
npm.cmd run db:upsert
```

PowerShell 실행 정책 때문에 `npm`이 막히면 `npm.cmd`를 사용합니다.

## 작업 흐름

1. `npm.cmd run batch`로 관심 종목의 최근 주가와 공시를 `dart-data.db`에 저장합니다.
2. `npm.cmd run filter:profitable`로 DART 기준 흑자 기업 목록을 갱신합니다.
3. `npm.cmd run score:kospi` 또는 `npm.cmd run score:kosdaq`로 시장별 점수 JSON을 생성합니다.
4. `npm.cmd run db:upsert`로 생성된 점수 데이터를 Supabase에 적재합니다.

## MCP 서버

Claude Desktop 설정 예시:

```json
{
  "mcpServers": {
    "dart-mcp": {
      "command": "node",
      "args": ["C:\\claudeT\\files\\mcp-server.js"],
      "env": {
        "DART_API_KEY": "your_dart_api_key_here",
        "PUBLIC_DATA_API_KEY": "your_public_data_api_key_here"
      }
    }
  }
}
```

제공 도구:

| 도구 | 설명 |
| --- | --- |
| `query_price` | 로컬 SQLite에서 종목 주가 이력을 조회합니다. |
| `query_disclosures` | 로컬 SQLite에서 공시 목록을 조회합니다. |
| `get_disclosure_body` | OpenDart 공시 본문을 실시간으로 가져옵니다. |
| `get_corp_info` | 종목코드로 OpenDart 기업 기본정보와 `corp_code`를 조회합니다. |
| `get_disclosures` | OpenDart 최근 공시 목록을 조회합니다. |
| `get_financials` | OpenDart 주요 재무 계정을 조회합니다. |
| `get_major_shareholders` | OpenDart 주요 주주 정보를 조회합니다. |
| `get_stock_price` | 공공데이터포털 최신 주가를 조회합니다. |
| `get_stock_history` | 공공데이터포털 기간별 OHLCV를 조회합니다. |
| `get_market_info` | KRX 상장종목 기본정보를 조회합니다. |

## 데이터 파일

`dart-data.db`, `dart-data.db-shm`, `dart-data.db-wal`, `scored-*.json`, `profitable-stocks.json`은 실행 산출물입니다. 기본적으로 `.gitignore`에 포함되어 있으며, 필요할 때 다시 생성합니다.

## 검증

```powershell
npm.cmd run check
npm.cmd test
```

`check`는 주요 JavaScript 파일의 문법을 확인합니다. `test`는 설정과 프로젝트 실행 계약을 검증합니다. 외부 API 호출이 필요한 배치/스코어링 명령은 API 키와 네트워크 상태에 따라 별도로 실행합니다.
