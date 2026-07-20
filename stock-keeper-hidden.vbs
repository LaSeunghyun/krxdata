' stock-keeper-hidden.vbs — stock-keeper.ps1을 콘솔 창 없이 실행 (2026-07-20).
' Task Scheduler가 이 VBS를 wscript로 호출 → PowerShell 창 깜빡임 방지.
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\claudeT\files\stock-keeper.ps1""", 0, False
