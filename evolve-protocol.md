# 재귀 개선 루프 프로토콜 (2026-06-12 시작, 24시간)

## 사이클 절차
1. 가설 백로그에서 1개 선택 → 구현 (backtest-swing.mjs 플래그 또는 코드)
2. Train(20230102~20241230) + Valid(20250102~20260611) 실행 (--strategies combo-v2)
3. 판정: **양 기간 모두 PF 개선(또는 PF 동률+MDD 개선) 시에만 채택**, 아니면 기각
4. 채택 시: 기본값으로 박제 + paper-swing.js 동기화 + 커밋
5. evolve-log.jsonl에 기록: {cycle, hypothesis, train:{pf,cagr,mdd,monWin}, valid:{...}, verdict, notes}
6. 사용자 보고: 수익률, 직전 채택본 대비 변화, 대표 매매 3~5건(종목/일자/사유/손익), 다음 가설
7. ScheduleWakeup ~1500초 → 다음 사이클

## 현재 채택본 (베이스라인)
combo-v2: trail=8, minbreak=3, maxholdr=5, stoppct=7, caps=A, regimema=20,60
- Train: PF 1.15, CAGR +26.2%, MDD 21.2%
- Valid: PF 1.59, CAGR +98.7%, MDD 17.1%, 월승률 72%

## 가설 백로그 (ICE 순)
- [진행중 C1] H3 거래량 필터: hi120 돌파일 거래량 > 20일평균 ×2 (--volx 2)
- [ ] H7 rsi2 2일 연속 과매도만 진입 (--rsidays 2)
- [ ] H2 DOWN 레짐 rsi2 사이즈 절반 (--downsize 0.5)
- [ ] H6 1R 도달 시 절반 익절 (--tp1r, hi120 서브) — 구현 필요
- [ ] H1 분봉 장중 손절 집행: stop_loss 트레이드의 당일 장중 스톱 터치 vs 익일 시가 비교 (분봉 수집 도구 필요, minute-cache.jsonl)
- [ ] H4 분봉 장중 트레일링: 일봉 고가 대신 분봉 고가 -8% 즉시 청산 시뮬
- [ ] H8 ATR 역가중 사이징
- [ ] H9 hi120 진입가를 돌파 종가 대신 익일 시가로 (gap 검증)
- [ ] H10 rsi2 universe 시총 top 30 → 50
- 분석에서 새 가설 발견 시 백로그에 추가

## 주의
- 같은 데이터 재탕 과적합 경계: 파라미터 미세 튜닝 금지, 구조적 가설만
- 분봉 API: 종목-일 단위 캐시 필수 (minute-cache/ 디렉토리, 코드-날짜.json)
- 보고는 매 사이클, 24시간 후(6/13 21:40 KST) 종합 보고 후 루프 종료
