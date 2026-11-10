param(
    [string]$Config = 'D:\AppData\WakeWire\workflows\remnote-todo\config.json',
    [string]$Entry = 'D:\Applications\WakeWire\node_modules\wakewire\dist\workflows\remnote-todo-cli.js',
    [string]$Node = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference = 'Stop'
$log = Join-Path (Split-Path -Parent $Config) 'scheduler.log'
$maintenanceExit = 0
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if ($settings.maintenanceConfigFile) {
    $maintenanceEntry = Join-Path (Split-Path -Parent $Entry) 'remnote-maintenance-cli.js'
    & $Node $maintenanceEntry run $settings.maintenanceConfigFile 2>&1 | Tee-Object -FilePath $log -Append
    $maintenanceExit = $LASTEXITCODE
}
& $Node $Entry run $Config 2>&1 | Tee-Object -FilePath $log -Append
$todoExit = $LASTEXITCODE
if ($maintenanceExit -ne 0) { exit $maintenanceExit }
exit $todoExit
