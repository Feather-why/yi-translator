param(
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [ValidateRange(1024,65535)][int]$Port = 8081,
    [switch]$Cpu,
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'setup-common.ps1')
. (Join-Path $PSScriptRoot 'local-helper-common.ps1')
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw '此安装包适用于 Windows x64；ARM 或其他系统请使用手动部署说明。' }
$root = Get-LocalProjectRoot
if (-not $PrepareOnly -and -not $ExtensionId) { $ExtensionId = (Read-Host '请粘贴浏览器扩展管理页中 Yi 的扩展 ID（32 个字母）').Trim() }
if (-not $PrepareOnly -and $ExtensionId -cnotmatch '^[a-p]{32}$') { throw '扩展 ID 格式错误，请从扩展管理页复制。' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'local-downloads.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -ne 1 -or $manifest.runtimeVersion -ne 'b12069') { throw '安装清单版本不匹配。' }
$mode = Get-SetupMode -Cpu:$Cpu
$runtime = Assert-SetupPath $root 'runtime\llama-b12069'
$model = Assert-SetupPath $root ('runtime\models\' + $manifest.model.name)
$mutex = New-Object Threading.Mutex($false, ('Local\TranslateSetup-' + (Get-LocalIdentity)))
$locked = $false
try {
    try { $locked = $mutex.WaitOne(1000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw '此目录的另一个安装程序正在运行。' }
    if (Test-LocalRunning) { throw '请先运行 stop-local.cmd 停止此目录的模型，再安装或切换模式。' }
    if (Test-Path -LiteralPath $runtime) { Assert-SetupManagedRuntime $root 'runtime\llama-b12069' }
    if ((Test-Path -LiteralPath $model) -and -not (Test-SetupFile $model $manifest.model)) { throw '已有模型文件校验不符，未覆盖；请换一个新的安装目录。' }
    Write-Host ('安装位置：' + $root + '；运行方式：' + $mode)
    Write-Host '模型约 1.13 GB；CUDA 模式还需约 0.59 GB 下载。模型和运行库保留提供方许可证，详见 README-local.txt。'
    if (-not (Test-SetupFile $model $manifest.model)) {
        $download = Get-SetupDownload $root $manifest.model
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($model))
        Move-Item -LiteralPath $download -Destination $model
    }
    $assets = @($manifest.$mode)
    if ($mode -eq 'cuda') { $assets += $manifest.cudaLibraries }
    $archives = @($assets | ForEach-Object { Get-SetupDownload $root $_ })
    $stageRelative = 'runtime\setup-' + [Guid]::NewGuid().ToString('N')
    $stage = Assert-SetupPath $root $stageRelative
    [void][IO.Directory]::CreateDirectory($stage)
    try {
        foreach ($archive in $archives) { Expand-SetupArchive $archive $stage }
        if (-not (Test-Path -LiteralPath (Join-Path $stage 'llama-server.exe') -PathType Leaf)) { throw '运行库中缺少 llama-server.exe。' }
        Install-SetupRuntime $root $stageRelative $mode
    } finally {
        if (Test-Path -LiteralPath $stage) { $null = Assert-SetupPath $root $stageRelative; Remove-Item -LiteralPath $stage -Recurse -Force }
    }
    if ($PrepareOnly) { Write-Host '文件准备完成；尚未启动模型或注册浏览器助手。'; return }
    & (Join-Path $PSScriptRoot 'run-local.ps1') -Cpu:($mode -eq 'cpu') -Port $Port -Background
    $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/health') -TimeoutSec 10
    if ($health.status -ne 'ok') { throw '模型健康检查没有通过，请查看 runtime\logs；可用 setup.cmd -Cpu 重试。' }
    & (Join-Path $PSScriptRoot 'install-helper.ps1') -ExtensionId @($ExtensionId)
    Write-Host ('完成。请在扩展中新手指引连接 http://127.0.0.1:' + $Port + '；开机自启仍由你在设置页开启。')
} finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
