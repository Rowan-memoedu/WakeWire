param(
    [string]$Config = 'D:\AppData\WakeWire\workflows\remnote-zhihu\config.json',
    [string]$Entry = 'D:\Applications\WakeWire\node_modules\wakewire\dist\workflows\remnote-zhihu-cli.js',
    [string]$Node = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
foreach ($required in @($Config, $Entry, $Node)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'A Zhihu workflow dependency is missing.' }
}
$log = Join-Path (Split-Path -Parent $Config) 'scheduler.log'
& $Node $Entry run $Config 2>&1 | Tee-Object -FilePath $log -Append
$workflowExit = $LASTEXITCODE
exit $workflowExit
