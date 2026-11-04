param(
    [Parameter(Position = 0)][string]$Origin,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$BrowserArguments
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'local-helper-common.ps1')
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$utf8 = New-Object Text.UTF8Encoding($false, $true)
function Write-NativeResponse($Value) {
    $body = $utf8.GetBytes(($Value | ConvertTo-Json -Compress -Depth 8))
    if ($body.Length -gt 65536) { throw 'Native response exceeded limit.' }
    $prefix = [BitConverter]::GetBytes([uint32]$body.Length)
    $outputStream.Write($prefix, 0, 4)
    $outputStream.Write($body, 0, $body.Length)
    $outputStream.Flush()
}
function Read-NativeBytes([int]$Count) {
    $bytes = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $read = $inputStream.Read($bytes, $offset, $Count - $offset)
        if ($read -eq 0) { if ($offset -eq 0) { return $null }; throw 'Truncated frame.' }
        $offset += $read
    }
    return ,$bytes
}
try {
    $manifestPath = Get-LocalHelperManifest
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or (Get-Item -LiteralPath $manifestPath).Length -gt 65536) { throw 'Helper not installed.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Origin -cnotmatch '^chrome-extension://[a-p]{32}/$' -or $manifest.name -ne $script:LocalHelperName -or $Origin -cnotin $manifest.allowed_origins) { throw 'Origin denied.' }
    # sendNativeMessage 一次一个请求；也兼容 connectNative 连续请求，串行操作避免设置互相覆盖。
    while ($true) {
        $prefix = Read-NativeBytes 4
        if ($null -eq $prefix) { break }
        $length = [BitConverter]::ToUInt32($prefix, 0)
        if ($length -eq 0 -or $length -gt 4096) { throw 'Invalid frame length.' }
        $bytes = Read-NativeBytes ([int]$length)
        if ($null -eq $bytes) { throw 'Truncated body.' }
        $message = $null
        try { $message = $utf8.GetString($bytes) | ConvertFrom-Json } catch { }
        $valid = $message -is [pscustomobject] -and $message.action -is [string]
        if ($valid) {
            $keys = @($message.PSObject.Properties.Name)
            $allowed = if ($message.action -ceq 'autostart') { @('action', 'enable') } else { @('action') }
            $valid = @($keys | Where-Object { $_ -cnotin $allowed }).Count -eq 0 -and $message.action -cin @('status', 'start', 'autostart')
            if ($message.action -ceq 'autostart') { $valid = $valid -and $message.enable -is [bool] }
        }
        if (-not $valid) {
            Write-NativeResponse @{ ok = $false; error = @{ code = 'bad_input'; message = '本机助手请求格式不正确。' } }
            continue
        }
        try {
            switch -CaseSensitive ($message.action) {
                'status' { $data = Get-LocalHelperStatus }
                'start' { $data = Start-LocalHelperModel }
                'autostart' { Set-LocalAutostart $message.enable; $data = Get-LocalHelperStatus }
            }
            Write-NativeResponse @{ ok = $true; data = $data }
        } catch {
            # 原始异常可能包含本机路径或环境值，协议只返回固定、可操作的说明。
            $text = if ($message.action -ceq 'start') { '本地模型未能启动，请确认模型文件已部署，并查看项目 runtime\logs 中的启动日志。' }
                elseif ($message.action -ceq 'autostart') { '无法修改本项目的开机启动项，请检查模型文件和当前用户启动文件夹。' }
                else { '无法读取本机助手状态，请重新运行 install-helper.cmd。' }
            Write-NativeResponse @{ ok = $false; error = @{ code = 'unavailable'; message = $text } }
        }
    }
} catch {
    # 畸形帧和不受信任origin不返回状态；stdout不输出任何日志。
    [Console]::Error.WriteLine('Translate native helper rejected the connection or malformed frame.')
    exit 1
} finally { $inputStream.Dispose(); $outputStream.Dispose() }
