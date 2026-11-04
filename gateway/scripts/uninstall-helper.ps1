$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-helper-common.ps1')
Invoke-LocalInstallation { Uninstall-LocalHelper }
Write-Host '已移除本项目的助手注册和开机启动项；不会停止已经运行的模型。'
