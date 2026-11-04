$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-helper-common.ps1')
Set-LocalAutostart $false
Write-Host '已关闭本项目的开机自启；不会停止已经运行的模型。'
