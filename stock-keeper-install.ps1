# stock-keeper-install.ps1 — STOCK-LiveKeeper 스케줄러 등록 (2026-07-21, v3 robust).
#   v1(Register+MaxValue): P99999999 XML 오류로 거부.
#   v2(schtasks /SC MINUTE /MO 5): 수 시간 뒤 반복이 멈추는 Windows 버그(Duration 무제한 stall).
#   v3: Register-ScheduledTask + 유한 Duration(365일) + AtLogon 재무장 + StartWhenAvailable.
#       - 5분 반복을 365일 유한 창으로 (무제한 Duration stall 회피)
#       - AtLogon 트리거가 로그인마다 창을 리셋 → 사실상 영구
#       - StartWhenAvailable → 재부팅/절전 복귀 시 놓친 실행 즉시 수행
#   실행:  powershell -NoProfile -ExecutionPolicy Bypass -File C:/claudeT/files/stock-keeper-install.ps1
$ErrorActionPreference = 'Stop'
try { Unregister-ScheduledTask -TaskName STOCK-LiveKeeper -Confirm:$false } catch {}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"C:\claudeT\files\stock-keeper-hidden.vbs"'
$trigLogon = New-ScheduledTaskTrigger -AtLogOn
$trigRep = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 365)   # 유한(365일) — 무제한 Duration stall 회피
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)

Register-ScheduledTask -TaskName STOCK-LiveKeeper `
  -Action $action -Trigger $trigLogon, $trigRep -Settings $settings -Force `
  -Description 'stock-live.mjs 생존 감시/재기동 (5분 유한반복 + 로그온 재무장)' | Out-Null

Write-Host "STOCK-LiveKeeper 재등록 완료 (v3):"
Get-ScheduledTask -TaskName STOCK-LiveKeeper | Select-Object TaskName, State | Format-List
$t = Get-ScheduledTask -TaskName STOCK-LiveKeeper
Write-Host ("반복 간격: {0} / Duration: {1}" -f $t.Triggers[1].Repetition.Interval, $t.Triggers[1].Repetition.Duration)
(Get-ScheduledTaskInfo -TaskName STOCK-LiveKeeper) | Select-Object LastRunTime, NextRunTime, LastTaskResult | Format-List
