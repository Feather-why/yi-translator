@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-local.ps1"
if errorlevel 1 echo Failed to stop the local model. See the message above.
pause
