@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0disable-autostart.ps1"
if errorlevel 1 echo Failed to disable autostart. See the message above.
pause
