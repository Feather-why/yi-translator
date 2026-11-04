$ErrorActionPreference = 'Stop'
$script:LocalHelperName = 'com.translate.local_model'
$script:LocalHelperRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Get-LocalProjectRoot { return $script:LocalHelperRoot }
function Get-LocalPowerShell { return (Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe') }
function Get-LocalStartupDirectory {
    $directory = [Environment]::GetFolderPath('Startup')
    if (-not $directory) { throw '当前账户没有可用的启动文件夹。' }
    return [IO.Path]::GetFullPath($directory)
}
function Get-LocalHash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ,$sha.ComputeHash($Bytes) } finally { $sha.Dispose() }
}
function Get-LocalIdentity {
    return ([BitConverter]::ToString((Get-LocalHash ([Text.Encoding]::UTF8.GetBytes((Get-LocalProjectRoot).ToLowerInvariant()))))).Replace('-', '').Substring(0, 16)
}
function Get-LocalRunArguments {
    return ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Background' -f (Join-Path (Get-LocalProjectRoot) 'gateway\scripts\run-local.ps1'))
}
function Get-LocalModelSettingsPath { return (Join-Path (Get-LocalProjectRoot) 'runtime\local-model.settings.json') }
function Assert-LocalModelSettings($Value) {
    # 只存四个有界数据值；绝不把磁盘配置拼成命令、可执行路径或附加参数。
    if ($Value -isnot [pscustomobject] -or ($Value.version -isnot [int] -and $Value.version -isnot [long]) -or $Value.version -ne 1 -or $Value.cpu -isnot [bool] -or
        @($Value.PSObject.Properties.Name | Where-Object { $_ -cnotin @('version', 'cpu', 'port', 'parallel', 'contextPerSlot') }).Count) { throw '本机启动配置格式不正确。' }
    foreach ($field in @(@('port', 1024, 65535), @('parallel', 1, 8), @('contextPerSlot', 512, 8192))) {
        $number = $Value.($field[0])
        if (($number -isnot [int] -and $number -isnot [long]) -or $number -lt $field[1] -or $number -gt $field[2]) { throw '本机启动配置数值不正确。' }
    }
    return $Value
}
function Get-LocalModelSettings {
    $path = Get-LocalModelSettingsPath
    if (-not (Test-Path -LiteralPath $path)) { return [pscustomobject]@{ version = 1; cpu = $false; port = 8081; parallel = 6; contextPerSlot = 2048 } }
    $file = Get-Item -LiteralPath $path
    if ($file.PSIsContainer -or $file.Length -gt 4096 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '本机启动配置文件不正确。' }
    return (Assert-LocalModelSettings (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json))
}
function Save-LocalModelSettings([bool]$Cpu, [int]$Port, [int]$Parallel, [int]$ContextPerSlot) {
    $value = Assert-LocalModelSettings ([pscustomobject]@{ version = 1; cpu = $Cpu; port = $Port; parallel = $Parallel; contextPerSlot = $ContextPerSlot })
    $path = [IO.Path]::GetFullPath((Get-LocalModelSettingsPath))
    $directory = [IO.Path]::GetFullPath((Join-Path (Get-LocalProjectRoot) 'runtime'))
    if ([IO.Path]::GetDirectoryName($path) -ne $directory) { throw '本机启动配置位置不正确。' }
    if (Test-Path -LiteralPath $path) {
        $file = Get-Item -LiteralPath $path
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '不覆盖非普通启动配置文件。' }
    }
    [void][IO.Directory]::CreateDirectory($directory)
    $temporary = Join-Path $directory ('local-model.settings-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        # 原子替换让助手并发查询只能读到完整旧版或新版；异常时保留已有配置。
        if (Test-Path -LiteralPath $path -PathType Leaf) { [IO.File]::Replace($temporary, $path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $path) }
    } finally { if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force } }
}
function Test-LocalFiles {
    $root = Get-LocalProjectRoot
    try { $null = Get-LocalModelSettings } catch { return $false }
    return ((Test-Path -LiteralPath (Join-Path $root 'gateway\scripts\run-local.ps1') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $root 'runtime\llama-b12069\llama-server.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $root 'runtime\models\Hy-MT2-1.8B-Q4_K_M.gguf') -PathType Leaf))
}
function Get-LocalLinkPath {
    $startup = Get-LocalStartupDirectory
    $link = [IO.Path]::GetFullPath((Join-Path $startup ('Translate Local Model-' + (Get-LocalIdentity) + '.lnk')))
    if ([IO.Path]::GetDirectoryName($link) -ne $startup) { throw '启动项路径不正确。' }
    return $link
}
function New-LocalShortcutShell { return New-Object -ComObject WScript.Shell }
function Test-LocalShortcut($Link) {
    return ([string]::Equals([string]$Link.TargetPath, (Get-LocalPowerShell), [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$Link.WorkingDirectory, (Get-LocalProjectRoot), [StringComparison]::OrdinalIgnoreCase) -and
        [string]$Link.Arguments -ceq (Get-LocalRunArguments) -and
        [string]$Link.Description -ceq ('Translate local model ' + (Get-LocalIdentity)))
}
function Get-LocalAutostart {
    $path = Get-LocalLinkPath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    $shell = New-LocalShortcutShell
    try { return [bool](Test-LocalShortcut ($shell.CreateShortcut($path))) }
    finally { if ([Runtime.InteropServices.Marshal]::IsComObject($shell)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) } }
}
function Set-LocalAutostart([bool]$Enable) {
    $mutex = New-Object Threading.Mutex($false, ('Local\TranslateAutostart-' + (Get-LocalIdentity)))
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw '另一个启动项设置操作正在进行。' }
        $path = Get-LocalLinkPath
        $exists = Test-Path -LiteralPath $path -PathType Leaf
        if ($exists -and -not (Get-LocalAutostart)) { throw '同名启动项不属于本项目，未覆盖或删除。' }
        if (-not $Enable) {
            if ($exists) { Remove-Item -LiteralPath $path -Force }
            return
        }
        if (-not (Test-LocalFiles)) { throw '请先部署本机模型和 llama-server。' }
        if ($exists) { return }
        $startup = Get-LocalStartupDirectory
        [void][IO.Directory]::CreateDirectory($startup)
        $temporary = [IO.Path]::GetFullPath((Join-Path $startup ('Translate-' + [Guid]::NewGuid().ToString('N') + '.lnk')))
        if ([IO.Path]::GetDirectoryName($temporary) -ne $startup) { throw '启动项临时路径不正确。' }
        $shell = New-LocalShortcutShell
        try {
            $link = $shell.CreateShortcut($temporary)
            $link.TargetPath = Get-LocalPowerShell
            $link.Arguments = Get-LocalRunArguments
            $link.WorkingDirectory = Get-LocalProjectRoot
            $link.Description = 'Translate local model ' + (Get-LocalIdentity)
            $link.WindowStyle = 7
            $link.Save()
            # 临时链接与最终链接都在已确认的当前用户 Startup 目录内。
            Move-Item -LiteralPath $temporary -Destination $path -ErrorAction Stop
        } finally {
            if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force }
            if ([Runtime.InteropServices.Marshal]::IsComObject($shell)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
        }
    } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
function Test-LocalRunning {
    $root = Get-LocalProjectRoot
    $statePath = Join-Path $root 'runtime\local-model.state.json'
    try {
        if (-not (Test-Path -LiteralPath $statePath -PathType Leaf) -or (Get-Item -LiteralPath $statePath).Length -gt 16384) { return $false }
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $settings = Get-LocalModelSettings
        if ($state.port -ne $settings.port -or -not $state.processId -or -not $state.startTimeUtc) { return $false }
        $expected = [IO.Path]::GetFullPath((Join-Path $root 'runtime\llama-b12069\llama-server.exe'))
        if (-not [string]::Equals([string]$state.executable, $expected, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        $candidate = Get-Process -Id ([int]$state.processId) -ErrorAction Stop
        $ticks = if ($state.startTimeUtc -is [DateTime]) { $state.startTimeUtc.ToUniversalTime().Ticks } else { ([DateTimeOffset]::Parse([string]$state.startTimeUtc)).UtcDateTime.Ticks }
        return ([string]::Equals($candidate.Path, $expected, [StringComparison]::OrdinalIgnoreCase) -and $candidate.StartTime.ToUniversalTime().Ticks -eq $ticks)
    } catch { return $false }
}
function Get-LocalHelperStatus {
    $canStart = [bool](Test-LocalFiles)
    $status = @{ supported = $true; enabled = [bool](Get-LocalAutostart); canStart = $canStart }
    if (-not $canStart) { $status.hint = '请先部署本机模型和 llama-server，再使用立即启动或开机自启。' }
    try { $null = Get-LocalModelSettings } catch { $status.hint = 'runtime\local-model.settings.json 无效；请用 start-local.cmd -Port 8081（CPU 模式再加 -Cpu）明确启动一次，成功后修复配置。' }
    return $status
}
function Start-LocalHelperModel {
    if (Test-LocalRunning) { return @{ ok = $true; message = '本地模型已经在运行。' } }
    if (-not (Test-LocalFiles)) { throw '请先部署本机模型和 llama-server。' }
    $root = Get-LocalProjectRoot
    $logs = Join-Path $root 'runtime\logs'
    [void][IO.Directory]::CreateDirectory($logs)
    $name = 'helper-start-' + [Guid]::NewGuid().ToString('N')
    # stdout 必须留给 native framing；子脚本的 Write-Host 和错误都进独立本机日志。
    $child = Start-Process -FilePath (Get-LocalPowerShell) -ArgumentList (Get-LocalRunArguments) -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs ($name + '.stdout.log')) -RedirectStandardError (Join-Path $logs ($name + '.stderr.log'))
    # Start-Process -Wait 会等待整棵进程树；这里只等启动脚本，不等长期运行的模型子进程。
    $handle = $child.Handle
    $child.WaitForExit()
    $child.Refresh()
    if ($child.ExitCode -ne 0 -or -not (Test-LocalRunning)) { throw '模型启动失败，请查看项目 runtime\logs 中的启动日志。' }
    return @{ ok = $true; message = '本地模型已启动；首次加载可能需要片刻。' }
}
function Get-LocalHelperDirectory { return (Join-Path (Get-LocalProjectRoot) 'runtime\helper') }
function Get-LocalHelperManifest { return (Join-Path (Get-LocalHelperDirectory) ($script:LocalHelperName + '.json')) }
function Get-LocalRegistration([string]$Browser) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(('Software\{0}\NativeMessagingHosts\{1}' -f $Browser, $script:LocalHelperName))
    if (-not $key) { return $null }
    try { return $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $key.Dispose() }
}
function Set-LocalRegistration([string]$Browser, [string]$Manifest) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(('Software\{0}\NativeMessagingHosts\{1}' -f $Browser, $script:LocalHelperName))
    try { $key.SetValue('', $Manifest, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
}
function Remove-LocalRegistration([string]$Browser) {
    # 只删本助手的精确子键，不对浏览器或 NativeMessagingHosts 父目录做递归清理。
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey(('Software\{0}\NativeMessagingHosts\{1}' -f $Browser, $script:LocalHelperName), $false)
}
function Get-LocalExtensionId([string]$Directory) {
    $full = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    $manifest = Get-Content -LiteralPath (Join-Path $full 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.key) { $bytes = [Convert]::FromBase64String([string]$manifest.key) }
    else {
        # Chromium GenerateIdForPath：Windows wchar_t UTF-16LE，只有盘符变为大写。
        if ($full -match '^[a-z]:') { $full = $full.Substring(0, 1).ToUpperInvariant() + $full.Substring(1) }
        $bytes = [Text.Encoding]::Unicode.GetBytes($full)
    }
    $hash = Get-LocalHash $bytes
    $builder = New-Object Text.StringBuilder
    foreach ($value in $hash[0..15]) { [void]$builder.Append([char](97 + ($value -shr 4))); [void]$builder.Append([char](97 + ($value -band 15))) }
    return $builder.ToString()
}
function Assert-LocalHelperOwner {
    $directory = Get-LocalHelperDirectory
    $ownerPath = Join-Path $directory 'owner.json'
    $hasFiles = @('owner.json', 'native-host.cmd', ($script:LocalHelperName + '.json')) | Where-Object { Test-Path -LiteralPath (Join-Path $directory $_) }
    if ($hasFiles) {
        if (-not (Test-Path -LiteralPath $ownerPath -PathType Leaf)) { throw '助手目录里有未知文件，未覆盖。' }
        $owner = Get-Content -LiteralPath $ownerPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($owner.name -ne $script:LocalHelperName -or -not [string]::Equals([string]$owner.project, (Get-LocalProjectRoot), [StringComparison]::OrdinalIgnoreCase)) { throw '已有助手不属于本项目，未覆盖。' }
    }
}
function Install-LocalHelper([string[]]$ExtensionId) {
    if (-not $ExtensionId) { $ExtensionId = @(Get-LocalExtensionId (Join-Path (Get-LocalProjectRoot) '.output\chrome-mv3')) }
    $ids = @($ExtensionId | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Select-Object -Unique)
    if (-not $ids.Count -or $ids.Count -gt 16 -or @($ids | Where-Object { $_ -cnotmatch '^[a-p]{32}$' }).Count) { throw '扩展 ID 必须是 32 个 a-p 字母。' }
    Assert-LocalHelperOwner
    $directory = [IO.Path]::GetFullPath((Get-LocalHelperDirectory))
    $manifestPath = Get-LocalHelperManifest
    $browsers = @('Google\Chrome', 'Microsoft\Edge')
    $beforeRegistry = @{}
    foreach ($browser in $browsers) {
        $beforeRegistry[$browser] = Get-LocalRegistration $browser
        if ($null -ne $beforeRegistry[$browser] -and -not [string]::Equals([string]$beforeRegistry[$browser], $manifestPath, [StringComparison]::OrdinalIgnoreCase)) { throw '浏览器已有另一位置的同名助手，请先从原项目卸载。' }
    }
    [void][IO.Directory]::CreateDirectory($directory)
    $utf8 = New-Object Text.UTF8Encoding($false)
    $manifest = @{ name = $script:LocalHelperName; description = 'Translate local model helper'; path = (Join-Path $directory 'native-host.cmd'); type = 'stdio'; allowed_origins = @($ids | ForEach-Object { 'chrome-extension://' + $_ + '/' }) } | ConvertTo-Json -Depth 4
    $launcher = "@echo off`r`n`"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"%~dp0..\..\gateway\scripts\native-host.ps1`" %*`r`n"
    $files = @{
        ($script:LocalHelperName + '.json') = $manifest
        'native-host.cmd' = $launcher
        'owner.json' = (@{ name = $script:LocalHelperName; project = (Get-LocalProjectRoot); version = 1 } | ConvertTo-Json)
    }
    $beforeFiles = @{}
    foreach ($name in $files.Keys) {
        $target = [IO.Path]::GetFullPath((Join-Path $directory $name))
        if ([IO.Path]::GetDirectoryName($target) -ne $directory) { throw '助手文件路径不正确。' }
        $beforeFiles[$name] = if (Test-Path -LiteralPath $target -PathType Leaf) { ,[IO.File]::ReadAllBytes($target) } else { $null }
    }
    try {
        foreach ($name in $files.Keys) { [IO.File]::WriteAllText((Join-Path $directory $name), $files[$name], $utf8) }
        foreach ($browser in $browsers) { Set-LocalRegistration $browser $manifestPath }
    } catch {
        foreach ($browser in $browsers) {
            if ([string]::Equals([string](Get-LocalRegistration $browser), $manifestPath, [StringComparison]::OrdinalIgnoreCase)) {
                if ($null -eq $beforeRegistry[$browser]) { Remove-LocalRegistration $browser } else { Set-LocalRegistration $browser $beforeRegistry[$browser] }
            }
        }
        foreach ($name in $files.Keys) {
            $target = Join-Path $directory $name
            if ($null -eq $beforeFiles[$name]) { if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force } }
            else { [IO.File]::WriteAllBytes($target, [byte[]]$beforeFiles[$name]) }
        }
        throw
    }
    return @{ installed = $true; host = $script:LocalHelperName; extensionIds = $ids; autostartChanged = $false }
}
function Uninstall-LocalHelper {
    Assert-LocalHelperOwner
    # 启动项不属于本项目时整次卸载停止，保留可检查的原状态。
    Set-LocalAutostart $false
    $manifestPath = Get-LocalHelperManifest
    foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
        if ([string]::Equals([string](Get-LocalRegistration $browser), $manifestPath, [StringComparison]::OrdinalIgnoreCase)) { Remove-LocalRegistration $browser }
    }
    $directory = [IO.Path]::GetFullPath((Get-LocalHelperDirectory))
    foreach ($name in @('owner.json', 'native-host.cmd', ($script:LocalHelperName + '.json'))) {
        $target = [IO.Path]::GetFullPath((Join-Path $directory $name))
        if ([IO.Path]::GetDirectoryName($target) -ne $directory) { throw '助手文件路径不正确。' }
        if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force }
    }
}
function Invoke-LocalInstallation([scriptblock]$Operation) {
    $mutex = New-Object Threading.Mutex($false, 'Local\TranslateLocalNativeInstallation')
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw '另一个助手安装操作正在进行。' }
        return (& $Operation)
    } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
