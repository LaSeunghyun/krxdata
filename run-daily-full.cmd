@echo off
rem KRXDATA daily data refresh: price + 52w + 20d turnover + ranking
rem Task Scheduler: weekdays 04:00 KST (StartWhenAvailable catches up if PC was off)
cd /d C:\claudeT\files
chcp 65001 >nul
echo [START full] %date% %time% >> daily-full.log
"C:\Program Files\nodejs\node.exe" daily-ranking.js >> daily-full.log 2>&1
echo [ranking-exit] code=%errorlevel% %date% %time% >> daily-full.log
"C:\Program Files\nodejs\node.exe" save-prices.mjs --backfill 7 >> daily-full.log 2>&1
echo [DONE full] %date% %time% >> daily-full.log
