$ErrorActionPreference = 'Stop'

function Assert-SetupPath([string]$Root, [string]$Relative) {
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $full = [IO.Path]::GetFullPath((Join-Path $base $Relative))
    if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '安装路径超出了安装目录。' }
    $check = $full
    while ($check) {
        if ((Test-Path -LiteralPath $check) -and ((Get-Item -LiteralPath $check -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '安装目录不能通过链接指向其他位置。' }
        $check = [IO.Path]::GetDirectoryName($check)
    }
    return $full
}
function Get-SetupHash([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
function Test-SetupFile([string]$File, $Asset) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf) -or (Get-Item -LiteralPath $File).Length -ne [long]$Asset.bytes) { return $false }
    $stream = [IO.File]::OpenRead($File)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '') -ieq [string]$Asset.sha256 }
    finally { $hash.Dispose(); $stream.Dispose() }
}
function Get-SetupDownload([string]$Root, $Asset) {
    if ($Asset.name -cnotmatch '^[A-Za-z0-9_.-]+$' -or $Asset.sha256 -cnotmatch '^[a-f0-9]{64}$' -or [long]$Asset.bytes -le 0) { throw '下载清单格式错误。' }
    $uri = [Uri]$Asset.url
    if ($uri.Scheme -ne 'https' -or $uri.Host -notin @('github.com', 'huggingface.co') -or $uri.UserInfo) { throw '只允许固定官方 HTTPS 下载来源。' }
    $target = Assert-SetupPath $Root ('runtime\downloads\' + $Asset.name)
    if (Test-SetupFile $target $Asset) { return $target }
    if (Test-Path -LiteralPath $target) { throw ('缓存文件校验失败，请先移走该文件后重试：' + $target) }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    $partial = Assert-SetupPath $Root ('runtime\downloads\' + $Asset.name + '.part')
    $ownership = Assert-SetupPath $Root ('runtime\downloads\' + $Asset.name + '.part.json')
    if (Test-Path -LiteralPath $ownership -PathType Leaf) {
        $owner = Get-Content -LiteralPath $ownership -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($owner.version -ne 1 -or $owner.url -cne $Asset.url -or $owner.sha256 -cne $Asset.sha256 -or [long]$owner.bytes -ne [long]$Asset.bytes) { throw '断点文件归属不符，未更改。' }
    } elseif ((Test-Path -LiteralPath $partial) -or (Test-Path -LiteralPath $ownership)) { throw '已有断点文件不属于此安装工具，未续写或删除；请先移走该文件。' }
    else {
        @{version=1;url=$Asset.url;sha256=$Asset.sha256;bytes=$Asset.bytes} | ConvertTo-Json | Set-Content -LiteralPath $ownership -Encoding UTF8
    }
    # 下载刚完成时断电也可直接校验并安装，不必发送会返回416的续传请求。
    if (Test-SetupFile $partial $Asset) {
        Move-Item -LiteralPath $partial -Destination $target
        Remove-Item -LiteralPath $ownership -Force
        return $target
    }
    $curl = Join-Path ([Environment]::GetFolderPath('System')) 'curl.exe'
    if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) { throw '需要 Windows 自带的 curl.exe，请更新 Windows 后重试。' }
    Write-Host ('下载 ' + $Asset.name + '；中断后可重新运行继续。')
    & $curl --disable --fail --location --retry 3 --connect-timeout 20 --proto '=https' --proto-redir '=https' --continue-at - --output $partial $Asset.url
    if ($LASTEXITCODE -ne 0) { throw '下载未完成，已保留断点；请重新运行安装。' }
    if (-not (Test-SetupFile $partial $Asset)) {
        # 只有本脚本刚下载的精确 .part 文件会删除，不碰既有模型和运行库。
        Remove-Item -LiteralPath $partial -Force
        Remove-Item -LiteralPath $ownership -Force
        throw ('下载校验失败，未安装：' + $Asset.name)
    }
    Move-Item -LiteralPath $partial -Destination $target
    Remove-Item -LiteralPath $ownership -Force
    return $target
}
function Expand-SetupArchive([string]$Archive, [string]$Directory) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [void][IO.Directory]::CreateDirectory($Directory)
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            if ([IO.Path]::IsPathRooted($entry.FullName) -or $entry.FullName.Contains(':')) { throw '压缩包含绝对路径。' }
            $out = Assert-SetupPath $Directory $entry.FullName
            if ($entry.FullName.EndsWith('/')) { [void][IO.Directory]::CreateDirectory($out); continue }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($out))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $out, $false)
        }
    } finally { $zip.Dispose() }
}
function Get-SetupMode([switch]$Cpu) {
    if ($Cpu) { return 'cpu' }
    $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if ($smi) {
        try {
            $summary = (& $smi.Source 2>$null) -join "`n"
            $v = [regex]::Match($summary, 'CUDA Version:\s*(\d+\.\d+)')
            $memory = @(& $smi.Source --query-gpu=memory.total --format=csv,noheader,nounits 2>$null)
            if ($v.Success -and [version]$v.Groups[1].Value -ge [version]'13.4' -and ($memory | Where-Object { $_ -match '^\d+$' -and [int]$_ -ge 4096 })) { return 'cuda' }
        } catch { }
    }
    return 'cpu'
}


function Get-SetupTree([string]$Directory) {
    $files = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $Directory -Force)) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '运行库中有链接，未更改任何已有文件。' }
        if ($item.PSIsContainer) { $files += @(Get-SetupTree $item.FullName) }
        else { $files += $item }
    }
    return $files
}
function Assert-SetupManagedRuntime([string]$Root, [string]$Relative) {
    $directory = Assert-SetupPath $Root $Relative
    $inventory = Assert-SetupPath $Root ($Relative + '\.yi-setup-runtime.json')
    if (-not (Test-Path -LiteralPath $inventory -PathType Leaf)) { throw '运行库不是此安装工具管理的，未更改；请使用新的安装目录。' }
    $managed = Get-Content -LiteralPath $inventory -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($managed.version -ne 1 -or $managed.runtimeVersion -ne 'b12069' -or $managed.mode -notin @('cpu','cuda') -or -not $managed.files) { throw '运行库归属清单无效，未更改。' }
    $actual = @(Get-SetupTree $directory | Where-Object { $_.FullName -ne $inventory })
    if ($actual.Count -ne @($managed.files.PSObject.Properties).Count) { throw '运行库里有后来添加或移走的文件，未更改；请使用新的安装目录。' }
    foreach ($file in $actual) {
        $name = $file.FullName.Substring($directory.Length + 1)
        $expected = $managed.files.PSObject.Properties[$name]
        if (-not $expected -or -not (Test-SetupFile $file.FullName $expected.Value)) { throw ('运行库文件被修改，未更改：' + $name) }
    }
}
function Install-SetupRuntime([string]$Root, [string]$StageRelative, [string]$Mode) {
    $stage = Assert-SetupPath $Root $StageRelative
    $runtime = Assert-SetupPath $Root 'runtime\llama-b12069'
    $inventoryPath = Assert-SetupPath $Root ($StageRelative + '\.yi-setup-runtime.json')
    if (Test-Path -LiteralPath $inventoryPath) { throw '运行库压缩包不应包含安装工具归属清单。' }
    $files = @{}
    foreach ($file in @(Get-SetupTree $stage)) {
        $name = $file.FullName.Substring($stage.Length + 1)
        $files[$name] = @{bytes=$file.Length;sha256=(Get-SetupHash $file.FullName)}
    }
    @{version=1;mode=$Mode;runtimeVersion='b12069';files=$files} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $inventoryPath -Encoding UTF8
    $backup = $null
    if (Test-Path -LiteralPath $runtime) {
        Assert-SetupManagedRuntime $Root 'runtime\llama-b12069'
        $installed = Get-Content -LiteralPath (Join-Path $runtime '.yi-setup-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $same = $installed.mode -eq $Mode -and @($installed.files.PSObject.Properties).Count -eq $files.Count
        foreach ($name in $files.Keys) {
            $old = $installed.files.PSObject.Properties[$name]
            if (-not $old -or $old.Value.sha256 -cne $files[$name].sha256 -or [long]$old.Value.bytes -ne [long]$files[$name].bytes) { $same = $false; break }
        }
        if ($same) { Write-Host '运行库已是所选方式且完整，继续使用现有文件。'; return }
        $backup = Assert-SetupPath $Root ('runtime\previous-' + [Guid]::NewGuid().ToString('N'))
        # 先完整保留旧目录；中断或移动失败都不会删除用户原有运行库。
        [IO.Directory]::Move($runtime, $backup)
    }
    try { [IO.Directory]::Move($stage, $runtime) }
    catch {
        if ($backup -and -not (Test-Path -LiteralPath $runtime)) { [IO.Directory]::Move($backup, $runtime) }
        throw
    }
    if ($backup) { Write-Host ('旧运行库完整保留在 ' + $backup + '；确认新版本可用后可手动移走。') }
}
