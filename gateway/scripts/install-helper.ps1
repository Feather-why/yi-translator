param([string[]]$ExtensionId)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-helper-common.ps1')
$result = Invoke-LocalInstallation { Install-LocalHelper $ExtensionId }
Write-Host ('已为当前用户安装 Chrome / Edge 本机助手，扩展 ID：' + ($result.extensionIds -join ', '))
Write-Host '安装不会自动打开开机自启。可在扩展里开启，或双击 enable-autostart.cmd。'
