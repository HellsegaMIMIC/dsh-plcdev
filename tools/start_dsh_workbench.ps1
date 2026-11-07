param(
    [string]$StateDirectory = '',
    [int]$Port = 55110,
    [string]$ProfileDirectory = '',
    [string]$EnvironmentConfig = '',
    [switch]$Teams,
    [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if ($EnvironmentConfig) { $env:PLCDEV_ENVIRONMENT_CONFIG = [IO.Path]::GetFullPath($EnvironmentConfig) }
. (Join-Path $PSScriptRoot 'plcdev_environment.ps1')
$toolEnvironment = Get-PlcdevEnvironment
if (-not $StateDirectory) { $StateDirectory = Join-Path $projectRoot 'outputs/dsh-plcdev' }
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
$python = $toolEnvironment.tools.python
$dsh = $toolEnvironment.tools.dshCli
$node = $toolEnvironment.tools.node
if (-not (Test-Path -LiteralPath $dsh)) { throw 'DSH dependency is missing. Follow software/dsh-plcdev/README.md first.' }
if (-not (Test-Path -LiteralPath $python)) { throw 'PLCdev agent Python environment is missing.' }
if (-not $ProfileDirectory) { $ProfileDirectory = Join-Path $projectRoot '.tools/dsh-plcdev-home' }
$env:DSH_HOME = [IO.Path]::GetFullPath($ProfileDirectory)
if (-not (Test-Path -LiteralPath (Join-Path $env:DSH_HOME 'profiles/web/package.json'))) {
    throw 'DSH profile is not initialized. Run install_dsh_workbench.ps1 with the same ProfileDirectory first.'
}
$env:PLCDEV_DSH_ROOT = $projectRoot
if ($Teams) {
    $env:PLCDEV_DSH_TEAMS = '1'
    $env:PLCDEV_TEAM_MODEL_SCOPE = Join-Path $StateDirectory 'team-model-scope.json'
    if (-not (Test-Path -LiteralPath $env:PLCDEV_TEAM_MODEL_SCOPE)) { throw 'Prepare the isolated Teams model scope first.' }
} else {
    Remove-Item Env:PLCDEV_DSH_TEAMS -ErrorAction SilentlyContinue
    Remove-Item Env:PLCDEV_TEAM_MODEL_SCOPE -ErrorAction SilentlyContinue
}
$env:PLCDEV_WORKBENCH_HOME = Join-Path $StateDirectory 'workbench'
$env:PLCDEV_AGENT_HOME = Join-Path $StateDirectory 'agent'
# A verification profile has its own catalog; otherwise use the normal catalog.
if (Test-Path -LiteralPath (Join-Path $StateDirectory 'projects.json')) {
    $env:PLCDEV_PROJECT_INDEX = Join-Path $StateDirectory 'projects.json'
} else { Remove-Item Env:PLCDEV_PROJECT_INDEX -ErrorAction SilentlyContinue }
$env:PLCDEV_DSH_CONTROLLER = Join-Path $env:PLCDEV_WORKBENCH_HOME 'controller.json'

# ensure starts only independent engineering services; it never prepares/runs PLC.
$ensure = & $python -B -X utf8 (Join-Path $PSScriptRoot 'plcdev_workbench.py') ensure
if ($LASTEXITCODE -ne 0) { throw 'PLCdev controller did not become ready.' }
$null = $ensure | ConvertFrom-Json # Never print its token-bearing URL.
$base = 'http://127.0.0.1:' + $Port
$descriptor = Get-Content -LiteralPath $env:PLCDEV_DSH_CONTROLLER -Raw | ConvertFrom-Json
$existing = $null
try { $existing = Invoke-RestMethod ($base + '/api/plcdev/health') -TimeoutSec 2 } catch {}
if ($existing -and $existing.instance -ne $descriptor.instance) {
    throw 'This port belongs to another PLCdev backend. Choose another port; no process was stopped.'
}
$expectedVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'software/dsh-plcdev/package.json') -Raw | ConvertFrom-Json).version
if ($existing -and ($existing.pluginVersion -ne $expectedVersion -or $existing.conversationApiVersion -ne 1)) {
    throw 'This port has an older PLCdev plugin. Use another port/profile or explicitly restart that host; no Runtime was stopped.'
}
$launchFile = Join-Path $StateDirectory 'dsh-launch.json'
if (-not $existing) {
    $outLog = Join-Path $StateDirectory 'dsh-start.log'
    $errLog = Join-Path $StateDirectory 'dsh-errors.log'
    $process = Start-Process -FilePath $node -ArgumentList @(('"'+$dsh+'"'),'web','--port',"$Port",'--no-open') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        if ($process.HasExited) { throw "DSH exited. Check $errLog" }
        Start-Sleep -Milliseconds 200
        try { $existing = Invoke-RestMethod ($base + '/api/plcdev/health') -TimeoutSec 1 } catch {}
    } until ($existing -or [DateTime]::UtcNow -gt $deadline)
    if (-not $existing) { throw "DSH is not ready. Check $errLog. No existing Runtime was stopped." }
    # HTTP registration can become ready before DSH flushes its startup URL.
    $entryDeadline = [DateTime]::UtcNow.AddSeconds(10)
    $match = [regex]::Match('', 'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_-]+')
    do {
        $startupOutput = Get-Content -LiteralPath $outLog -Raw
        if ($startupOutput) {
            $match = [regex]::Match($startupOutput, 'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_-]+')
        }
        if (-not $match.Success) { Start-Sleep -Milliseconds 150 }
    } until ($match.Success -or [DateTime]::UtcNow -gt $entryDeadline)
    if (-not $match.Success) { throw 'DSH did not provide its local browser entry.' }
    @{url=$match.Value; hostInstance=$existing.hostInstance; pid=$existing.hostPid} | ConvertTo-Json | Set-Content -LiteralPath $launchFile -Encoding utf8
}
if (-not $NoOpen) {
    if (-not (Test-Path -LiteralPath $launchFile)) { throw 'This DSH was launched elsewhere. Use its original browser tab or startup URL.' }
    $launch = Get-Content -LiteralPath $launchFile -Raw | ConvertFrom-Json
    if ($launch.hostInstance -ne $existing.hostInstance) { throw 'Saved entry is stale; use the current host startup entry.' }
    Start-Process $launch.url
}
Write-Output ('PLCdev DSH ready: ' + $base + ' (select PLCdev in the sidebar)')
