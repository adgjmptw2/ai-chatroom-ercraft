$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
$ownerPath = Join-Path $root 'data\.service-runtime\owner.json'
$mutex = [Threading.Mutex]::new($false, 'Local\ERCraftAiChatroomWindowsHost')
$owns = $false
try {
  try { $owns = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owns = $true }
  if (-not $owns) { exit 0 }
  Set-Location -LiteralPath $root
  $env:CHATROOM_HOME = $root
  $env:CHATROOM_CONFIG = Join-Path $root 'config.json'
  $env:PATH = 'C:\Program Files\nodejs;' + $env:PATH
  $portText = & $node (Join-Path $PSScriptRoot 'windows-service-host.mjs') --configured-port
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read configured port' }
  $port = [int]$portText
  if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid configured port' }
  if (Test-Path -LiteralPath $ownerPath) {
    $owner = Get-Content -LiteralPath $ownerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $owner.supervisorPid -or -not $owner.startedAt) { throw 'Invalid ownership record; manual inspection required' }
    $processes = @(Get-CimInstance Win32_Process)
    $ids = @([int]$owner.supervisorPid, [int]$owner.childPid) | Where-Object { $_ -gt 0 }
    $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
    $priorBoot = ([DateTimeOffset]::Parse($owner.startedAt).UtcDateTime -lt $boot)
    $active = @($processes | Where-Object {
      ((-not $priorBoot) -and ($_.ProcessId -in $ids -or $_.ParentProcessId -in $ids)) -or
      ($_.Name -eq 'node.exe' -and $_.CommandLine -match [regex]::Escape($root) -and
       $_.CommandLine -match '(windows-service-host|scripts[\\/]service|[\\/]server)\.mjs')
    })
    if ($active.Count) { throw 'Previous service owner or child remains; no takeover attempted' }
    $ports = @($port)
    if ($owner.controlPort) { $ports += [int]$owner.controlPort }
    if (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ports }) {
      throw 'Service or control listener remains; no takeover attempted'
    }
    # Preserve the old record in its existing private directory; never print it.
    $archive = Join-Path (Split-Path -Parent $ownerPath) ('owner.stale-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '.json')
    Move-Item -LiteralPath $ownerPath -Destination $archive
  }
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw 'Chatroom port occupied' }
  & $node (Join-Path $PSScriptRoot 'windows-service-host.mjs')
  exit $LASTEXITCODE
} catch {
  # Do not log process commands, configuration, or exception messages.
  $log = Join-Path $root 'data\.service-runtime\windows-launcher.jsonl'
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 1048576) {
    Move-Item -LiteralPath $log -Destination ($log + '.previous') -Force
  }
  @{at=[DateTime]::UtcNow.ToString('o');event='launcher-refused-or-failed';type=$_.Exception.GetType().Name;line=$_.InvocationInfo.ScriptLineNumber;errorId=$_.FullyQualifiedErrorId} |
    ConvertTo-Json -Compress | Add-Content -LiteralPath $log -Encoding UTF8
  exit 1
} finally {
  if ($owns) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
