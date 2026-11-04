@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-local.ps1" %*
set "yiExit=%ERRORLEVEL%"
if not "%yiExit%"=="0" echo Setup failed. See the message above. You may retry with -Cpu.
pause
exit /b %yiExit%
