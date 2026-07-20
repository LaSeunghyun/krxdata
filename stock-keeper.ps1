# stock-keeper.ps1 — stock-live.mjs 생존 감시/재기동 (2026-07-20).
#   node stock-live.mjs --go 프로세스가 없으면 숨김 창으로 재기동.
#   Windows Task Scheduler에서 5분마다 + 로그온 시 호출.
#   PS 5.1 단일객체 .Count=$null 함정 방지 위해 @()로 배열 강제.
$ErrorActionPreference = 'SilentlyContinue'
$dir = 'C:\claudeT\files'
$log = Join-Path $dir 'stock-keeper-log.txt'
$ts  = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')

# stock-live 프로세스 탐지 (node.exe 중 CommandLine에 stock-live 포함)
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*stock-live*' })

if ($procs.Count -ge 1) {
  Add-Content $log "[$ts] alive (pid=$($procs[0].ProcessId)) — skip"
  exit 0
}

# 미실행 → 숨김 창으로 재기동
Add-Content $log "[$ts] not running — relaunching"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node.exe'
$psi.Arguments = 'stock-live.mjs --go'
$psi.WorkingDirectory = $dir
$psi.WindowStyle = 'Hidden'
$psi.CreateNoWindow = $true
$psi.UseShellExecute = $false
$p = [System.Diagnostics.Process]::Start($psi)
Add-Content $log "[$ts] relaunched pid=$($p.Id)"
exit 0
