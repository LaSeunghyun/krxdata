# stock-autostart-install.ps1 — 재부팅/로그온 시 자동복구 (2026-07-21).
#   기존 STOCK-LiveKeeper(5분 감시)는 StartWhenAvailable=False라 재부팅 후 즉시 안 뜰 수 있음.
#   로그온 트리거 작업을 추가 → 로그인하면 keeper VBS 실행 → stock-live 없으면 기동(있으면 skip).
#   schtasks에 StartWhenAvailable 플래그가 없어 ONLOGON으로 대체(가장 확실한 재부팅 복구).
#   실행: powershell -NoProfile -ExecutionPolicy Bypass -File C:/claudeT/files/stock-autostart-install.ps1
schtasks /Delete /TN STOCK-LiveKeeper-Logon /F 2>$null
schtasks /Create /TN STOCK-LiveKeeper-Logon /TR "wscript.exe C:\claudeT\files\stock-keeper-hidden.vbs" /SC ONLOGON /F
Write-Host "`n--- 등록 확인 (로그온 자동복구) ---"
schtasks /Query /TN STOCK-LiveKeeper-Logon /FO LIST
Write-Host "`n이제 재부팅/로그인 시 stock-live가 자동 기동됩니다 (수동 wscript 불필요)."
Write-Host "단, PC가 꺼진 동안은 손절이 작동하지 않는 점은 동일 — PC를 켜둬야 방어됩니다."
