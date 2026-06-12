# 재귀 개선 루프 프로토콜 v2 (2026-06-12 23:12 재시작, 12시간 — 6/13 11:12 KST 종료)

## ★ 최종 상태 (2026-06-13 00:30 기준 — 차기 세션 인수인계)
- **채택본 동결**: combo-v2 = trail8 / minbreak3 / maxholdr5 / stoppct7 / rsiDays2 / tp1R1 / rsiMa3 / tp2R2 (backtest-swing.mjs·paper-swing.js 동기화 완료)
- **성과**: Train PF 1.21/+31.9/MDD 15.3 · Valid PF 1.96/+117.8/MDD 11.6 · 전기간 PF 1.63/+62.4 (1000만→5142만)
- **검증**: 연도별 전 흑자(최약 2024 PF 1.11) · 스트레스(비용 2배) PF 1.43 · 월별 42개월 중 26개월 흑자, 최악월 -123만
- **33사이클 종료**: 채택 5 / 기각 26 / 검증 통과 2. C15~C33 19연속 기각 = 수렴
- **제3 서브전략 탐색 종료**: 눌림목(PF 0.75)·갭추종(PF 0.78) 기각 — hi120+rsi2 2서브가 완성형
- **보수 옵션**: --atrsize 4 → MDD 7.0%/CAGR +57% (계좌 확대 시 검토)
- **운영**: GitHub Actions daily-ranking.yml (KST 09:03 morning / 15:45 close) + 텔레그램 보고 + -30% 서킷브레이커

## 사이클 절차
1. 가설 백로그에서 1개 선택 → 구현 (backtest-swing.mjs 플래그 또는 코드)
2. Train(20230102~20241230) + Valid(20250102~20260611) 실행 (--strategies combo-v2, **--dump evolve-cN-trades.json 필수**)
3. 판정: **양 기간 모두 PF 개선(또는 PF 동률+MDD 개선) 시에만 채택**, 아니면 기각
4. 채택 시: 기본값으로 박제 + paper-swing.js 동기화 + 커밋
5. evolve-log.jsonl에 기록: {cycle, hypothesis, train:{pf,cagr,mdd}, valid:{...}, verdict, notes}
6. **상세 보고 (v2 강화 — 매 사이클 필수)**:
   - 지표 비교표 (vs 베이스라인)
   - **대표 매매 5건+: 종목명 / 매수일·매수가 / 매도일·매도가 / 매수 사유(시그널·레짐) / 매도 사유 / 손익%**
   - 손실 매매 분석: 왜 잃었나, 피할 수 있었나
   - 개선점 도출 → 새 가설로 백로그 추가
7. ScheduleWakeup ~120s 틱으로 백테스트 완료 감시 → 판정 → 다음 사이클

## 현재 채택본 (베이스라인, C13 반영)
combo-v2: trail=8, minbreak=3, maxholdr=5, stoppct=7, rsiDays=2, tp1R=1, **rsiMa=3**
- Train: PF 1.20, CAGR +29.9%, MDD 15.6%, 월승률 58%
- Valid: PF 1.94, CAGR +117.9%, MDD 11.8%, 월승률 67%
- 채택 이력: trail8 (스윕) → C2 rsiDays2 → C7 tp1R → C13 rsiMa3

## 확정된 구조 원칙 (재검증 금지)
- 종가 판정 + 익일 시가 집행 (장중 청산 전 계열 기각 C4~C6)
- hi120 돌파 종가 진입 = 갭업 수익원 (C11 강한 기각)
- DOWN 레짐 rsi2 정상 사이즈 유지 (C3, C12 기각)
- rsi2: top30 / 보유 5일 / 2일 연속 과매도 / ma3 청산
- hi120: 돌파폭 3%+ / 1R 절반익절 / 트레일링 8%

## 가설 백로그 (2차 발굴, 전기간 재분석 기반 — final2 덤프)
- [진행중 C26] H31 돌파 실패 청산: 종가 < 돌파 기준선(120일 고가) 회귀 시 즉시 청산 (--breakfail 1) — trailing 손실 -14.9M 직접 공략
- [ ] H28 rsi2 조건부 타임스톱: 3일째 종가 < 진입가면 조기 청산 (max_hold 46건 전패 -3.9M 공략)
- [ ] H33 피라미딩: tp_half 도달 종목에 잔여 현금으로 1회 증액
- 소진 시: final2 덤프 보유일×레짐×연도 교차 재분석

## 소진된 가설 계열 (재시도 금지)
진입 필터(volx C1·maxbreak C16·lookback240 C21·closeloc C24·rsivol C25), 슬롯 배분(C19·C20), 레짐 방식(breadth C23), 장중 청산(C4~C6), 익절 교체(rsitp C22), 트레일 폭(C15), 쿨다운(C18), ATR 사이징(C17·보수옵션), downflat(C12), entryopen(C11)

## 주의
- 같은 데이터 재탕 과적합 경계: 파라미터 미세 튜닝 금지, 구조적 가설만
- 보고는 매 사이클 상세히 (매매 내역 + 사유 + 개선점), 12시간 후(6/13 11:12 KST) 종합 보고 후 루프 종료
- 세션 종료 대비: 매 사이클 상태를 이 파일+evolve-log.jsonl에 영속화
