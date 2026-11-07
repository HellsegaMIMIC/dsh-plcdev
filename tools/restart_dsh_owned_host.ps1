param([Parameter(Mandatory)][string]$StateDirectory, [Parameter(Mandatory)][int]$Port, [switch]$Teams)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$state = [IO.Path]::GetFullPath($StateDirectory)
$outputs = [IO.Path]::GetFullPath((Join-Path $projectRoot 'outputs')) + [IO.Path]::DirectorySeparatorChar
if (-not $state.StartsWith($outputs, [StringComparison]::OrdinalIgnoreCase)) { throw 'Only an isolated outputs state may be restarted.' }
$launch = Get-Content -LiteralPath (Join-Path $state 'dsh-launch.json') -Raw | ConvertFrom-Json
$base = 'http://127.0.0.1:' + $Port
$process = Get-Process -Id $launch.pid -ErrorAction Stop
$started = $process.StartTime
$health = Invoke-RestMethod ($base + '/api/plcdev/health') -TimeoutSec 3
if ($health.hostInstance -ne $launch.hostInstance -or $health.hostPid -ne $process.Id -or $process.ProcessName -ne 'node') { throw 'Saved launch does not own this Host; no process was stopped.' }
$process.Refresh()
if ($process.HasExited -or $process.StartTime -ne $started) { throw 'Host process changed before restart.' }
$health | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $state 'host-before-restart.json') -Encoding utf8
# Only this verified DSH host. Independent controller, task service and Runtime remain owned elsewhere.
$process.Kill()
if (-not $process.WaitForExit(10000)) { throw 'Owned Host has not exited.' }
& (Join-Path $PSScriptRoot 'start_dsh_workbench.ps1') -StateDirectory $state -ProfileDirectory (Join-Path $state 'dsh-home') -Port $Port -Teams:$Teams -NoOpen
$after = Invoke-RestMethod ($base + '/api/plcdev/health') -TimeoutSec 3
if ($after.hostInstance -eq $health.hostInstance -or $after.instance -ne $health.instance) { throw 'Host restart or independent controller continuity not confirmed.' }
$after | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $state 'host-after-restart.json') -Encoding utf8
Write-Output 'Owned Host restarted; independent controller identity is unchanged.'
