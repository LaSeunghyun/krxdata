@echo off
rem Detached full re-scoring runner: KOSPI then KOSDAQ, single log.
rem Launch: Start-Process cmd -ArgumentList '/c','C:\claudeT\files\run-scoring.cmd' -WindowStyle Hidden
cd /d C:\claudeT\files
chcp 65001 >nul
echo [START] %date% %time% > scoring-run.log
node score-kospi-full.js >> scoring-run.log 2>&1
echo [KOSPI-EXIT] code=%errorlevel% %date% %time% >> scoring-run.log
node score-kosdaq.js >> scoring-run.log 2>&1
echo [KOSDAQ-EXIT] code=%errorlevel% %date% %time% >> scoring-run.log
echo [ALL-DONE] %date% %time% >> scoring-run.log
