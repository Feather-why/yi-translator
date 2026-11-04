$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'runtime'))
$statePath = Join-Path $runtimeRoot 'local-model.state.json'
if (-not $statePath.StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '状态文件位置不正确。' }
$sha = [Security.Cryptography.SHA256]::Create()
try { $mutexSuffix = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($runtimeRoot.ToLowerInvariant())))).Replace('-', '').Substring(0, 20) }
finally { $sha.Dispose() }
$mutex = New-Object Threading.Mutex($false, ('Local\TranslateLocalModel-' + $mutexSuffix))
$locked = $false
try {
  try { $locked = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw '另一个启动或停止操作正在进行，请稍后再试。' }
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { Write-Host '本项目没有正在管理的本地模型进程。'; return }
  $state = $null
  try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { }
  $tracked = $null
  if ($state -and $state.processId -and $state.executable -and $state.startTimeUtc) {
    try {
      $candidate = Get-Process -Id ([int]$state.processId) -ErrorAction Stop
      # 同时兼容 PS5 的字符串和 PS7 的 DateTime，避免格式化丢失创建时间精度。
      $recordedTicks = if ($state.startTimeUtc -is [DateTime]) { $state.startTimeUtc.ToUniversalTime().Ticks } else { ([DateTimeOffset]::Parse([string]$state.startTimeUtc)).UtcDateTime.Ticks }
      if ([string]::Equals($candidate.Path, [string]$state.executable, [StringComparison]::OrdinalIgnoreCase) -and
        $candidate.StartTime.ToUniversalTime().Ticks -eq $recordedTicks) { $tracked = $candidate }
    } catch { }
  }
  if ($tracked) {
    # 同时核对可执行文件和创建时间，防止 PID 被系统复用后误停其他程序。
    Stop-Process -InputObject $tracked -ErrorAction Stop
    $tracked.WaitForExit(10000) | Out-Null
    if (-not $tracked.HasExited) { throw '模型服务尚未退出，请稍后重试。' }
    Write-Host '本地模型已停止，模型占用的显存将由系统释放。'
  } else { Write-Host '记录中的模型已退出或身份不匹配；未停止任何其他进程。' }
  Remove-Item -LiteralPath $statePath -Force
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
