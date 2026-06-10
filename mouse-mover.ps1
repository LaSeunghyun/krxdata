Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

Write-Host 마우스 자동 이동 시작 (5초 간격). 5px 이상 움직이면 종료.

while ($true) {
    $before = [System.Windows.Forms.Cursor]::Position

    Start-Sleep 5

    $current = [System.Windows.Forms.Cursor]::Position
    $dx = [Math]::Abs($current.X - $before.X)
    $dy = [Math]::Abs($current.Y - $before.Y)
    if ($dx -gt 5 -or $dy -gt 5) {
        Write-Host $(Get-Date -Format 'HH:mm:ss') 사용자 이동 감지 — 종료
        break
    }

    $x = $before.X
    $y = $before.Y
    [System.Windows.Forms.Cursor]::Position = [System.Drawing.Point]::new($x + 1, $y)
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.Cursor]::Position = [System.Drawing.Point]::new($x, $y)
    Write-Host $(Get-Date -Format 'HH:mm:ss') 이동 완료
}