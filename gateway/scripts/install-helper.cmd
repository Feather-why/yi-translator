@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-helper.ps1" %*
if errorlevel 1 echo Failed to install the local helper. See the message above.
pause
