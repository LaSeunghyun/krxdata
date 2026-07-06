@echo off
rem KRXDATA paper/live swing runner (paper-swing.js).
rem Phase (morning execute / close signals) is auto-detected by real KST clock,
rem so a late catch-up run is safe: it does the phase matching the actual time, or no-ops.
rem Task Scheduler: weekdays 09:03 (morning) and 15:45 (close) KST, StartWhenAvailable.
cd /d C:\claudeT\files
chcp 65001 >nul
echo [START paper] %date% %time% >> paper.log
"C:\Program Files\nodejs\node.exe" paper-swing.js >> paper.log 2>&1
echo [DONE paper] code=%errorlevel% %date% %time% >> paper.log
