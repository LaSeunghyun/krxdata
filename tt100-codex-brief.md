너는 실계좌 자동매매 repo(C:\claudeT\files)의 정량 연구원이다. 이번 작업은 연구/검증 전용이며 정확성이 최우선이다.

# 절대 금지 (하드 가드레일 — 위반 시 즉시 중단)
- stock-live.mjs, strategy-contract.mjs, live-parity.mjs의 동작 변경 금지 (읽기만).
- 네트워크로 SSH(ubuntu@134.185.111.69)·scp·systemctl·토스/브로커 API 호출·주문 실행 절대 금지.
- 허용되는 네트워크 사용은 오직 Supabase 읽기 쿼리(sector/disclosure/prices 조회)뿐.
- VM 배포, systemd 재시작, 실계좌 동작 변경은 명시 승인 없이는 절대 하지 마라.
- 모든 신규 코드는 연구 harness(신규 파일)와 research-results/ 에만. 기존 live 경로는 불변.
- live-parity.mjs의 buildLiveCandidates 기본 동작을 바꾸지 마라(라이브 봇이 import함). satellite/kelly/meta 로직은 연구 harness에서만 구현.

# 착수 순서
1. AGENTS.md / CLAUDE.md 있으면 읽어라.
2. git status --short 확인.
3. 기준선 파일 정독: stock-live.mjs, backtest-swing.mjs, live-parity.mjs, strategy-contract.mjs.

# 가장 먼저: 검증 기준선 (이전 실행서 미스매치 발견 → 해결 완료, 이제 진행하라)
현재 live 로직 = RSI_ENTRY_FILTER.volMin=1.25 + skipNeutral=true + SMA20/60 레짐 + LIVE_SLOTS=3 + PARTIAL_TP +4%/+8%.
(참고: 2026-07-23 HMA30 레짐을 잠깐 배포했다가 진짜 live 설정 재검증서 SMA보다 나빠 롤백함 → 현재 live 레짐 = SMA20/60. --regimemode 안 씀.)
이전 실행에서 네가 정확히 지적한 slots/tp 미스매치를 반영한 **올바른 live 기준선(이 스트링으로 고정)**:
  node backtest-swing.mjs --strategies combo-v2 --live-parity --skipneutralrsi --rsivol 1.25 --slots 3 --tp1r 0.5 --tp2r 1
매핑 확인: --slots 3 = LIVE_SLOTS; --tp1r 0.5 / --tp2r 1 = trailPct(8)×N = +4%/+8% = PARTIAL_TP; 레짐 기본 = SMA20/60(HMA 롤백); --skipneutralrsi + --rsivol 1.25 = RSI_ENTRY_FILTER.
이 스트링으로 stock-live.mjs(regimeOf SMA·RSI_ENTRY_FILTER·CAPITAL_DEPLOY slots=3·PARTIAL_TP)와 한 줄씩 대조해 일치 확인한 뒤 **TT100 연구를 실제로 진행하라**(이전엔 slots/tp 누락으로 중단했으나 이제 해결됨). 만약 남은 불일치를 또 발견하면 그때만 REPORT에 적고 멈춰라.
안전: 로컬 candles-daily.jsonl에 없는 종목(140910,204210,230980,451700,464680)은 --exclude로 빼거나, 이전에 만든 research-results/tt100-2026-07-23/cache-only-fetch-filter.mjs 가드를 재사용해 브로커 API(getDailyCandles) 폴스루를 막아라. 네트워크는 Supabase 읽기만, SSH/scp/systemctl/브로커주문 금지.

# 목표함수 TT100
TT100 = 시작자본이 100,000,000원에 처음 도달하는 데 걸린 거래일 수.
시작자본 = 6,000,000원(현재 실계좌)으로 고정(10,000,000 기준도 병기 가능).
리포트 최상단에 수학적 현실을 명시: 6M→100M=16.4배. 검증된 CAGR(live-parity ~11~21%)에선 도달에 8~15년.
- P(6/12/24개월 내 1억)은 비파산 전략에서 사실상 ≈ 0.
- 백테 창(2023-01-02~2026-06-11, ~838거래일)에선 baseline이 1억에 거의 미도달 → TT100은 우측절단(censored)으로 처리(무한대 아님).
- 빠른 도달 경로는 본질적으로 극단 집중/레버리지 = 고사망확률. 리포트 헤드라인 = "속도 ⟺ 계좌사망확률".

# 계측 추가 (신규, additive — 기존 기본출력 불변)
backtest-swing.mjs 또는 별도 harness에 새 플래그/모드로 추가:
- 고정 시작자본에서 일별 equity 경로 → 첫 equity≥1e8 거래일(TT100), 미도달이면 censored.
- 원금 50% 이하 하락 도달 여부, 70% 이상 손실(계좌 사망) 도달 여부.

# 연구 후보 (권장: B 중심)
A. Baseline — 위 기준선 스트링 그대로.
B. Aggressive Barbell — main 60/70/80% baseline + satellite 40/30/20%. satellite 후보:
   (1) volsurge (backtest에 --volsurge "volMin,dayRetMin,closeLocMin,cap" 옵션 이미 있음. 단 라이브 진입 트리거로는 MC서 기각됨=고점추격 유해 → barbell satellite 맥락에서만 재평가)
   (2) hi120 집중형
   (3) 공시/AI shadow 고확신 촉매형 (파일: ai-events.mjs·ai-signals.mjs·ai-judge.mjs·ai-shadow.mjs. 공시는 ~3개월 데이터라 백테 표본 빈약 — 반드시 명시)
   (4) 신고가 재돌파 + 거래량 확인
   satellite DD가 임계 초과 시 kill-switch로 동결.
C. Kelly-like — 0.25/0.5/0.75/1.0x fractional. edge는 sub별 과거 trade 결과에서만 추정(미래 데이터 금지). full Kelly 배포 금지.
D. Meta-filter — 후보를 새로 만들기보다 "살지/사이즈 줄일지" 판단. triple-barrier(target/stop/horizon) 라벨. 입력: regime, HMA slope, rsi2, breakoutPct, volRatio, closeLoc, ATR, ret5, sector, market vol.

# 반드시 보고할 지표
P(6개월 내 1억), P(12개월 내 1억), P(24개월 내 1억), median/p25/p75 TT100(절단 반영), P(원금 50% 이하 하락), P(계좌 사망: 70%↑ 손실/재기불가), max drawdown, MC worst path, 거래 수·회전율·비용 민감도.
최종잔고 중앙값보다 "도달확률·사망확률"을 우선한다.

# 검증 원칙
- CAGR만 보고 고르지 마라.
- Monte Carlo ≥ subsample 0.8 × 20 seed.
- TT100은 시간경로 의존이라 subsample(유니버스 변동)만으론 부족 → block bootstrap(수익률 블록 재표본)으로 시간경로 다양성 확보 필수.
- 비용 스트레스(수수료/세금/슬리피지 악화) 시나리오 포함.
- 생존편향 있으면 LIVE_ELIGIBLE 금지(현 데이터=현재상장만 → 전부 낙관, TT100도 낙관).
- 같은 날 종가 신호를 같은 종가에 매수하는 구조면 optimistic으로 표시. live와 다르게 체결되면 live-parity라 부르지 마라.
- 파라미터 많이 돌렸으면 PBO/과최적화 위험 별도 경고(barbell×kelly×meta = 조합 폭발).
- Supabase/API 병렬 오류 시 concurrency 1로 낮춰 재시도.

# 산출물
1. research-results/tt100-YYYY-MM-DD/REPORT.md (헤드라인=속도 vs 사망확률, 후보별 지표표, 방법론·한계)
2. research-results/tt100-YYYY-MM-DD/summary.json
3. 후보별 raw 결과
4. 후보별 NO_DEPLOY / SHADOW_ONLY / LIVE_CANDIDATE 판정
5. 실계좌 변경 제안은 별도 섹션에만, 절대 적용하지 마라.

# 통과 기준
- 단일 백테스트에서 1억 도달은 불충분.
- 최소한 baseline 대비 TT100 또는 1억 도달확률이 개선 + 파산/70% 손실 확률 명시가 동반돼야 후보.
- 위험을 숨기지 마라. "가장 빠르지만 계좌 사망확률 높음"이면 그렇게 써라. 적격 후보 없으면 없다고 결론내라.

# 검증 명령
- npm.cmd run check
- npm.cmd test
- 변경한 .mjs 파일마다 node --check

# 코드베이스 참고사실 (context-free이므로 명시)
- 레짐: 2026-07-23 SMA20/60 → HMA30 실계좌 배포됨(stock-live.mjs regimeOf, backtest는 --regimemode hma --regimehma 30). backtest hmaAt/wmaAt(약 482~506행)·hmaRegime(약 378~393행)과 동일 구현.
- live-parity 갭 이력: getDailyCandles는 newest-first→reverse 필수(regime 버그 수정됨). idealized momUniverse는 생존편향(CAGR 72% 착시 → live-parity ~11%). 판정은 항상 --live-parity.
- 데이터: 전 종목 일봉은 candles-daily.jsonl 로컬 캐시(2026-06-11까지, TO 기본값과 일치). stock_prices(close만, volume 없음), 공시 stock_disclosures(~3개월), 수급 stock_investor_flows(~43종목)은 Supabase. 전부 현재상장 기준=생존편향.
- 사이징: strategy-contract.mjs의 CAPITAL_DEPLOY(자본기반 진입), CONVICTION_SIZING, PARTIAL_TP(+4/8), LIVE_SLOTS=3.

작업을 시작하기 전에 위 "착수 순서"와 "검증 기준선"을 반드시 먼저 수행하라. 최종적으로 research-results/tt100-<날짜>/REPORT.md 에 결과와 NO_DEPLOY/SHADOW_ONLY/LIVE_CANDIDATE 판정을 남겨라.
