param(
    [string]$ProfileDirectory = '',
    [string]$PluginDirectory = '',
    [string]$EnvironmentConfig = '',
    [switch]$SkipDependencyInstall
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if ($EnvironmentConfig) { $env:PLCDEV_ENVIRONMENT_CONFIG = [IO.Path]::GetFullPath($EnvironmentConfig) }
. (Join-Path $PSScriptRoot 'plcdev_environment.ps1')
$toolEnvironment = Get-PlcdevEnvironment
$node = $toolEnvironment.tools.node
$dsh = $toolEnvironment.tools.dshCli
$hostDirectory = [IO.Path]::GetFullPath((Join-Path (Split-Path $dsh -Parent) '../../../..'))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
if (-not $PluginDirectory) { $PluginDirectory = Join-Path $projectRoot 'software/dsh-plcdev' }
$pluginDirectory = [IO.Path]::GetFullPath($PluginDirectory)
$pluginManifest = Get-Content -LiteralPath (Join-Path $pluginDirectory 'package.json') -Raw | ConvertFrom-Json
if ($pluginManifest.name -ne 'dsh-plcdev') { throw 'Expected the PLCdev plugin package.' }
New-Item -ItemType Directory -Force -Path $hostDirectory | Out-Null
if ($SkipDependencyInstall) {
    foreach ($dependency in @(@('@deepseek-ai/dsh','0.2.1-rc.5'), @('esbuild','0.25.12'))) {
        $manifest = Join-Path $hostDirectory ('node_modules/' + $dependency[0] + '/package.json')
        if (-not (Test-Path -LiteralPath $manifest) -or (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version -ne $dependency[1]) {
            throw ('Installed dependency version differs: ' + $dependency[0])
        }
    }
} else {
    $hostPackage = @{name='plcdev-dsh-host';private=$true;dependencies=@{'@deepseek-ai/dsh'='0.2.1-rc.5';esbuild='0.25.12'}} | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText((Join-Path $hostDirectory 'package.json'), $hostPackage, $utf8NoBom)
    $dependencyLock = Join-Path $projectRoot 'config/dsh-host.package-lock.json'
    if (-not (Test-Path -LiteralPath $dependencyLock)) { throw 'Pinned DSH dependency lock is missing.' }
    Copy-Item -LiteralPath $dependencyLock -Destination (Join-Path $hostDirectory 'package-lock.json')
    & npm.cmd ci --prefix $hostDirectory --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'DSH dependency installation failed.' }
}
if (-not $ProfileDirectory) { $ProfileDirectory = Join-Path $projectRoot '.tools/dsh-plcdev-home' }
$env:DSH_HOME = [IO.Path]::GetFullPath($ProfileDirectory)
& $node $dsh web --help
if ($LASTEXITCODE -ne 0) { throw 'DSH profile initialization failed.' }
$profile = Join-Path $env:DSH_HOME 'profiles/web'
$packageFile = Join-Path $profile 'package.json'
$package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
$package.dependencies | Add-Member -NotePropertyName 'dsh-plcdev' -NotePropertyValue ('link:' + $pluginDirectory.Replace('\','/')) -Force
if ('dsh-plcdev' -notin $package.dsh.profile.bundles) { $package.dsh.profile.bundles += 'dsh-plcdev' }
[IO.File]::WriteAllText($packageFile, ($package | ConvertTo-Json -Depth 8), $utf8NoBom)
$modules = Join-Path $profile 'node_modules'
New-Item -ItemType Directory -Force -Path $modules | Out-Null
$linkPath = Join-Path $modules 'dsh-plcdev'
if (Test-Path -LiteralPath $linkPath) {
    $linked = Get-Item -LiteralPath $linkPath
    if ($linked.LinkType -ne 'Junction' -or $linked.Target -ne $pluginDirectory) { throw 'Existing plugin path differs; review it before replacing.' }
} else { New-Item -ItemType Junction -Path $linkPath -Target $pluginDirectory | Out-Null }
$env:PLCDEV_DSH_BUILD_PACKAGE = Join-Path $hostDirectory 'package.json'
& $node (Join-Path $pluginDirectory 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'PLCdev client build failed.' }
Write-Output 'DSH PLCdev plugin is built and linked in the independent local Web profile.'
