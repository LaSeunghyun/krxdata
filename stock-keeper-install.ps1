# stock-keeper-install.ps1 — STOCK-LiveKeeper 스케줄러 등록 (2026-07-20, v2 schtasks).
#   [TimeSpan]::MaxValue 기반 Register-ScheduledTask는 잘못된 XML duration을 만들어 거부됨.
#   schtasks.exe /SC MINUTE /MO 5 는 무한반복을 네이티브로 처리하고 재부팅 후 자동 재개.
#   경로에 공백 없음 → /TR 내부 인용부호 불필요.
#   실행:  powershell -NoProfile -ExecutionPolicy Bypass -File C:/claudeT/files/stock-keeper-install.ps1
$tr = 'wscript.exe C:\claudeT\files\stock-keeper-hidden.vbs'
schtasks /Create /TN STOCK-LiveKeeper /TR $tr /SC MINUTE /MO 5 /F
Write-Host "`n--- 등록 확인 ---"
schtasks /Query /TN STOCK-LiveKeeper /FO LIST
