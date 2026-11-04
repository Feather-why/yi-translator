param(
  [string]$ModelPath,
  [string]$LlamaServer,
  [ValidateRange(1024, 65535)][int]$Port = 8081,
  [ValidateRange(0, 8)][int]$Parallel = 0,
  [ValidateRange(512, 8192)][int]$ContextPerSlot = 2048,
  [switch]$Cpu,
  [switch]$Background
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-helper-common.ps1')
# 双击、助手和已有开机快捷方式都复用上次成功的参数；手动只覆盖本次指定的字段。
$explicitLaunch = @($PSBoundParameters.Keys | Where-Object { $_ -ne 'Background' }).Count -gt 0
try { $saved = Get-LocalModelSettings }
catch {
  if (-not $explicitLaunch) { throw }
  # 只有用户明确手动给参数时才允许用安全默认修复坏文件；助手不擅自改启动方式。
  $saved = [pscustomobject]@{ cpu = $false; port = 8081; parallel = 6; contextPerSlot = 2048 }
}
if (-not $PSBoundParameters.ContainsKey('Cpu')) { $Cpu = [bool]$saved.cpu }
if (-not $PSBoundParameters.ContainsKey('Port')) { $Port = [int]$saved.port }
if (-not $PSBoundParameters.ContainsKey('ContextPerSlot')) { $ContextPerSlot = [int]$saved.contextPerSlot }
if (-not $PSBoundParameters.ContainsKey('Parallel')) { $Parallel = if ($PSBoundParameters.ContainsKey('Cpu')) { 0 } else { [int]$saved.parallel } }
# 实测这台 5070 Ti 六路吞吐优于八路；CPU 保留两路，且每路上下文不能被总槽数稀释。
if ($Parallel -eq 0) { $Parallel = if ($Cpu) { 2 } else { 6 } }
$contextSize = $Parallel * $ContextPerSlot
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'runtime'))
$statePath = Join-Path $runtimeRoot 'local-model.state.json'
if (-not $statePath.StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '状态文件位置不正确。' }
if (-not $ModelPath) { $ModelPath = Join-Path $runtimeRoot 'models\Hy-MT2-1.8B-Q4_K_M.gguf' }
if (-not $LlamaServer) { $LlamaServer = Join-Path $runtimeRoot 'llama-b12069\llama-server.exe' }
if (-not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) { throw '找不到模型文件，请先下载 Hy-MT2-1.8B-Q4_K_M.gguf，或用 -ModelPath 指定位置。' }
$resolvedModel = (Resolve-Path -LiteralPath $ModelPath).Path
$application = Get-Command -Name $LlamaServer -CommandType Application -ErrorAction Stop
$resolvedExe = [IO.Path]::GetFullPath($application.Source)
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

# 同一项目的双击启动/停止共用互斥锁，避免两次启动互相覆盖进程记录。
$sha = [Security.Cryptography.SHA256]::Create()
try { $mutexSuffix = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($runtimeRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 20) }
finally { $sha.Dispose() }
$mutex = New-Object Threading.Mutex($false, ('Local\TranslateLocalModel-' + $mutexSuffix))
$locked = $false
$serverProcess = $null
try {
  try { $locked = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw '另一个启动或停止操作正在进行，请稍后再试。' }
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $old = $null
    try { $old = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { }
    $tracked = $null
    if ($old -and $old.processId -and $old.startTimeUtc -and $old.executable) {
      try {
        $candidate = Get-Process -Id ([int]$old.processId) -ErrorAction Stop
        # PowerShell 7 会将 JSON ISO 时间直接读成 DateTime；再转字符串会丢小数精度。
        $recordedTicks = if ($old.startTimeUtc -is [DateTime]) { $old.startTimeUtc.ToUniversalTime().Ticks } else { ([DateTimeOffset]::Parse([string]$old.startTimeUtc)).UtcDateTime.Ticks }
        if ([string]::Equals($candidate.Path, [string]$old.executable, [StringComparison]::OrdinalIgnoreCase) -and
          $candidate.StartTime.ToUniversalTime().Ticks -eq $recordedTicks) { $tracked = $candidate }
      } catch { }
    }
    if ($tracked) {
      Write-Host ('本地模型已经启动：http://127.0.0.1:{0}（进程 {1}）' -f $old.port, $old.processId)
      Write-Host '如需切换模型或端口，请先运行 stop-local.cmd。'
      return
    }
    # 仅移除本项目的过期记录，绝不根据过期 PID 终止其他程序。
    Remove-Item -LiteralPath $statePath -Force
  }
  $client = New-Object Net.Sockets.TcpClient
  try {
    $connection = $client.ConnectAsync('127.0.0.1', $Port)
    if ($connection.Wait(500) -and $client.Connected) { throw ('端口 {0} 已被其他服务占用，不会替换该服务。' -f $Port) }
  } catch [AggregateException] { } finally { $client.Dispose() }
  $gpuLayers = if ($Cpu) { '0' } else { '99' }
  $arguments = @('-m', ('"{0}"' -f $resolvedModel), '--host', '127.0.0.1', '--port', [string]$Port,
    '-ngl', $gpuLayers, '-fa', 'on', '-c', [string]$contextSize, '-np', [string]$Parallel, '-ctk', 'q8_0', '-ctv', 'q8_0',
    '-b', '512', '-ub', '256', '--jinja', '--temp', '0.7', '--top-p', '0.6', '--top-k', '20',
    '--min-p', '0', '--repeat-penalty', '1.05', '--cache-ram', '128', '--sleep-idle-seconds', '600')
  $logsRoot = Join-Path $runtimeRoot 'logs'
  New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $stdoutLog = Join-Path $logsRoot ('llama-' + $stamp + '.stdout.log')
  $stderrLog = Join-Path $logsRoot ('llama-' + $stamp + '.stderr.log')
  if ($Background) {
    $serverProcess = Start-Process -FilePath $resolvedExe -ArgumentList $arguments -WorkingDirectory (Split-Path $resolvedExe) `
      -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
  } else {
    $serverProcess = Start-Process -FilePath $resolvedExe -ArgumentList $arguments -WorkingDirectory (Split-Path $resolvedExe) -NoNewWindow -PassThru
  }
  $state = [ordered]@{ version = 2; processId = $serverProcess.Id; startTimeUtc = $serverProcess.StartTime.ToUniversalTime().ToString('o');
    executable = $resolvedExe; modelPath = $resolvedModel; port = $Port; cpu = [bool]$Cpu;
    parallel = $Parallel; contextPerSlot = $ContextPerSlot; contextSize = $contextSize;
    stdoutLog = if ($Background) { $stdoutLog } else { $null }; stderrLog = if ($Background) { $stderrLog } else { $null } }
  $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
  $mutex.ReleaseMutex(); $locked = $false
  $ready = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $deadline) {
    $serverProcess.Refresh()
    if ($serverProcess.HasExited) { throw ('模型服务启动失败，请检查日志：' + $stderrLog) }
    try { $health = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/health' -f $Port) -TimeoutSec 2; $ready = $health.status -eq 'ok' } catch { }
    if ($ready) { break }
    Start-Sleep -Milliseconds 300
  }
  if ($ready) {
    $defaultModel = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'models\Hy-MT2-1.8B-Q4_K_M.gguf'))
    $defaultExe = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'llama-b12069\llama-server.exe'))
    if ([string]::Equals($resolvedModel, $defaultModel, [StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($resolvedExe, $defaultExe, [StringComparison]::OrdinalIgnoreCase)) {
      try {
        try { $locked = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw '启动配置暂时忙碌。' }
        $current = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $currentTicks = if ($current.startTimeUtc -is [DateTime]) { $current.startTimeUtc.ToUniversalTime().Ticks } else { ([DateTimeOffset]::Parse([string]$current.startTimeUtc)).UtcDateTime.Ticks }
        $serverProcess.Refresh()
        # 加载期间用户可能已停止或另启进程，旧启动不能覆盖新配置。
        if (-not $serverProcess.HasExited -and $current.processId -eq $serverProcess.Id -and $currentTicks -eq $serverProcess.StartTime.ToUniversalTime().Ticks) {
          Save-LocalModelSettings -Cpu ([bool]$Cpu) -Port $Port -Parallel $Parallel -ContextPerSlot $ContextPerSlot
        }
      } catch { Write-Warning '模型已就绪，但未保存启动参数；请检查 runtime 目录的写入权限或启动配置文件。' }
      finally { if ($locked) { $mutex.ReleaseMutex(); $locked = $false } }
    } else { Write-Warning '自定义模型或程序路径仅用于本次手动运行；开机自启仍使用项目默认模型和已保存的启动参数。' }
  }
  if ($Background) {
    if ($ready) { Write-Host ('本地模型已就绪：http://127.0.0.1:{0}' -f $Port) }
    else {
      Write-Host ('服务进程已启动，模型仍在加载：http://127.0.0.1:{0}' -f $Port)
      Write-Warning '60 秒内尚未就绪，本次启动参数未保存；若要让助手复用，请加载完成后先停止，再带相同参数启动一次。'
    }
    Write-Host '插件设置：启用「本地 Hy-MT2（llama.cpp）」，地址填写上面的地址，API key 留空。'
    Write-Host ('并行 {0} 路，每路上下文 {1}，总上下文 {2}。' -f $Parallel, $ContextPerSlot, $contextSize)
    Write-Host '闲置 10 分钟会自动卸载模型，下次翻译时自动加载；停止请运行 stop-local.cmd。'
    Write-Host ('运行日志：' + $stderrLog)
  } else {
    Write-Host ('本地模型正在前台运行：http://127.0.0.1:{0}；停止可按 Ctrl+C 或运行 stop-local.cmd。' -f $Port)
    $serverProcess.WaitForExit()
    $exitCode = $serverProcess.ExitCode
    if (Test-Path -LiteralPath $statePath) {
      $current = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
      if ($current.processId -eq $serverProcess.Id -and $current.startTimeUtc -eq $state.startTimeUtc) { Remove-Item -LiteralPath $statePath -Force }
    }
    exit $exitCode
  }
} catch {
  if ($serverProcess) {
    $serverProcess.Refresh()
    if (-not $serverProcess.HasExited) { Stop-Process -InputObject $serverProcess -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $statePath) {
      try { $current = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json; if ($current.processId -eq $serverProcess.Id) { Remove-Item -LiteralPath $statePath -Force } } catch { }
    }
  }
  throw
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
