# stock-keeper-install.ps1 — STOCK-LiveKeeper 스케줄러 등록 (2026-07-21, v4 schtasks-daily).
#   v2(schtasks /SC MINUTE /MO 5): Duration 무제한 → ~18h 뒤 반복 stall.
#   v3(Register-ScheduledTask): 이 사용자 컨텍스트에서 액세스 거부(0x80070005).
#   v4: schtasks.exe(권한 OK) + 일일 창(/ST 00:00 /ET 23:59) 5분 반복.
#       /SC MINUTE는 매일 재무장되므로 단일 무제한 창 stall을 회피. 00:00~23:59 매 5분 감시.
#   실행:  powershell -NoProfile -ExecutionPolicy Bypass -File C:/claudeT/files/stock-keeper-install.ps1
schtasks /Delete /TN STOCK-LiveKeeper /F 2>$null
$tr = 'wscript.exe C:\claudeT\files\stock-keeper-hidden.vbs'
schtasks /Create /TN STOCK-LiveKeeper /TR $tr /SC MINUTE /MO 5 /ST 00:00 /ET 23:59 /F
Write-Host "`n--- 등록 확인 ---"
schtasks /Query /TN STOCK-LiveKeeper /FO LIST
Write-Host "`n--- 즉시 1회 실행(프로세스 살아있으면 skip) ---"
schtasks /Run /TN STOCK-LiveKeeper
