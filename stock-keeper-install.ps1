# stock-keeper-install.ps1 — STOCK-LiveKeeper 스케줄러 등록 (2026-07-21, v5 daily+RI).
#   v2(/SC MINUTE /MO 5): 무한이지만 가끔 수십분 공백(Duration 무제한).
#   v3(Register-ScheduledTask): 액세스 거부(0x80070005).
#   v4(/SC MINUTE /ST /ET): EndBoundary가 당일 23:59로 고정 → 오늘 밤 영구정지(불가).
#   v5: /SC DAILY /ST 00:00 /RI 5 /DU 24:00 — 매일 재무장(daily 반복, EndBoundary 없음) +
#       매일 00:00부터 24h 동안 5분(/RI)마다 실행. 영구 지속 + 매일 리셋으로 stall 회피.
#   실행:  powershell -NoProfile -ExecutionPolicy Bypass -File C:/claudeT/files/stock-keeper-install.ps1
schtasks /Delete /TN STOCK-LiveKeeper /F 2>$null
$tr = 'wscript.exe C:\claudeT\files\stock-keeper-hidden.vbs'
schtasks /Create /TN STOCK-LiveKeeper /TR $tr /SC DAILY /MO 1 /ST 00:00 /RI 5 /DU 24:00 /F
Write-Host "`n--- 트리거 경계 확인 (EndBoundary 없어야 정상) ---"
$t = Get-ScheduledTask -TaskName STOCK-LiveKeeper
$t.Triggers[0] | Format-List StartBoundary, EndBoundary
$t.Triggers[0].Repetition | Format-List Interval, Duration
Write-Host "--- 상태 ---"
(Get-ScheduledTaskInfo -TaskName STOCK-LiveKeeper | Select-Object LastRunTime, NextRunTime, LastTaskResult | Format-List | Out-String).Trim()
Write-Host "`n--- 즉시 1회 실행 ---"
schtasks /Run /TN STOCK-LiveKeeper
