@echo off
rem 반기(11012) DART 색인 감시 러너 (halfyear-watch.mjs).
rem 매일 1회 색인률을 표본 확인하고, 80% 넘는 날 전량 재적재 + 스크리닝을 1회만 수행한다.
rem 완료되면 .halfyear-watch-done-<year><code> 마커가 생기고 이후 실행은 즉시 종료한다.
rem Task Scheduler: 평일 06:30 KST (04:00 DailyFull 이후, 07:50 forecast 이전 — 충돌 없음).
rem 마커 삭제 후 재실행하면 다시 감시한다. 작업 제거: schtasks /delete /tn KRXDATA-HalfYearWatch /f
cd /d C:\claudeT\files
chcp 65001 >nul
if exist ".halfyear-watch-done-202611012" (
  echo [SKIP halfyear-watch] already done %date% %time% >> halfyear-watch.log
  exit /b 0
)
echo [START halfyear-watch] %date% %time% >> halfyear-watch.log
"C:\Program Files\nodejs\node.exe" halfyear-watch.mjs >> halfyear-watch.log 2>&1
echo [DONE halfyear-watch] code=%errorlevel% %date% %time% >> halfyear-watch.log
