@echo off
rem KRXDATA market forecast ledger runner (forecast-run.mjs).
rem Phase (pre / close / daily) is auto-detected by real KST clock, so a late
rem catch-up run is safe: it does the phase matching the actual time, or no-ops.
rem Task Scheduler (weekdays KST, StartWhenAvailable): 07:50 pre / 10:30 11:30 13:30 14:30 intraday
rem / 16:10 close / 20:00 daily.
rem NOTE: never schedule inside 09:00-09:30 (paper-swing live order window - Toss token contention).
rem Catch-up collisions are further guarded by the paper run_lock recency check in forecast-run.mjs.
cd /d C:\claudeT\files
chcp 65001 >nul
echo [START forecast] %date% %time% >> forecast.log
"C:\Program Files\nodejs\node.exe" forecast-run.mjs >> forecast.log 2>&1
echo [DONE forecast] code=%errorlevel% %date% %time% >> forecast.log
