# live-guard.ps1 - keep live-day alive (PowerShell native, ASCII only for PS5.1 safety).
$ErrorActionPreference = 'SilentlyContinue'
$running = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*live-day.mjs --go*' }).Count
if ($running -eq 0) {
  $node = 'C:\Program Files\nodejs\node.exe'
  $a = @('live-day.mjs','--go','--until','2026-07-26T11:00:00+09:00','--tp','2','--stop','15')
  Start-Process -FilePath $node -ArgumentList $a -WorkingDirectory 'C:\claudeT\files' -WindowStyle Hidden
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path 'C:\claudeT\files\live-day-log.txt' -Value ('[' + $ts + '] [guard.ps1] live-day down -> restarted')
}
