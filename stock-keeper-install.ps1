# stock-keeper-install.ps1 — STOCK-LiveKeeper 스케줄러 등록 (2026-07-20).
#   실거래 프로세스를 지속 재기동하는 영속 작업이라 사용자가 직접 1회 실행해야 함
#   (Claude auto 모드 classifier가 세션 밖 영속 실행을 차단).
#   실행:  powershell -NoProfile -ExecutionPolicy Bypass -File C:\claudeT\files\stock-keeper-install.ps1
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '"C:\claudeT\files\stock-keeper-hidden.vbs"'
$trigLogon = New-ScheduledTaskTrigger -AtLogOn
$trigMin = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "STOCK-LiveKeeper" `
  -Action $action -Trigger $trigLogon, $trigMin -Settings $settings -Force `
  -Description "stock-live.mjs 생존 감시/재기동 (5분+로그온)" | Out-Null
Write-Host "STOCK-LiveKeeper 등록 완료:"
Get-ScheduledTask -TaskName "STOCK-LiveKeeper" | Select-Object TaskName, State | Format-List
