$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-helper-common.ps1')
Set-LocalAutostart $true
Write-Host '已启用当前用户登录 Windows 后自动启动本地模型。'
