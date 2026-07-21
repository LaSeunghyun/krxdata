@echo off
rem KRXDATA market forecast ledger runner (forecast-run.mjs).
rem Phase (pre / close / daily) is auto-detected by real KST clock, so a late
rem catch-up run is safe: it does the phase matching the actual time, or no-ops.
rem Task Scheduler: weekdays 08:35 (pre), 16:10 (close), 20:00 (daily) KST, StartWhenAvailable.
rem NOTE: never schedule inside 09:00-11:30 (paper-swing live order window - Toss token contention).
cd /d C:\claudeT\files
chcp 65001 >nul
echo [START forecast] %date% %time% >> forecast.log
"C:\Program Files\nodejs\node.exe" forecast-run.mjs >> forecast.log 2>&1
echo [DONE forecast] code=%errorlevel% %date% %time% >> forecast.log
