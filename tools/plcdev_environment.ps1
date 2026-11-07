function Get-PlcdevEnvironment {
    $environmentScript = Join-Path $PSScriptRoot 'plcdev_environment.py'
    $bootstrapPython = (Get-Command python -ErrorAction Stop).Source
    $json = & $bootstrapPython -B -X utf8 $environmentScript show
    if ($LASTEXITCODE -ne 0) { throw 'Invalid PLCdev environment configuration.' }
    return ($json | ConvertFrom-Json)
}
