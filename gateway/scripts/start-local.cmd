@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-local.ps1" -Background %*
if errorlevel 1 echo Failed to start the local model. See the message above.
pause
