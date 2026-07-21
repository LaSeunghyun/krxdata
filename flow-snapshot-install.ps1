# flow-snapshot-install.ps1 — STOCK-FlowSnapshot 일일 스케줄 등록 (2026-07-21).
#   장 마감 후 18:00 매일 KIS 수급 스냅샷 축적. schtasks /flags가 Git Bash에서 경로로
#   오인되는 문제를 피하려 .ps1로 감쌈. 실행:
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:/claudeT/files/flow-snapshot-install.ps1
schtasks /Delete /TN STOCK-FlowSnapshot /F 2>$null
schtasks /Create /TN STOCK-FlowSnapshot /TR "C:\claudeT\files\run-flow-snapshot.cmd" /SC DAILY /ST 18:00 /F
Write-Host "`n--- 등록 확인 ---"
schtasks /Query /TN STOCK-FlowSnapshot /FO LIST
