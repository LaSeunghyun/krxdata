@echo off
REM run-live-guard.cmd — Windows 작업 스케줄러가 1분마다 호출. live-day 미가동이면 재시작.
REM 세션·터미널·재부팅과 독립적으로 OS가 직접 살린다 (하네스 백그라운드 트리에 안 묶임).
cd /d C:\claudeT\files
for /f %%C in ('powershell -NoProfile -Command "@(Get-CimInstance Win32_Process ^| Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*live-day.mjs --go*' }).Count"') do set RUNNING=%%C
if "%RUNNING%"=="0" (
  echo [%date% %time%] live-day 미가동 -> 재시작 >> live-day-log.txt
  start "" /b node live-day.mjs --go --until 2026-07-26T11:00:00+09:00 --tp 2 --stop 15
)
