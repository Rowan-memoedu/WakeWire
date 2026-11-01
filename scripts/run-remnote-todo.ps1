param(
    [string]$Config = 'D:\AppData\WakeWire\workflows\remnote-todo\config.json',
    [string]$Entry = 'D:\Applications\WakeWire\node_modules\wakewire\dist\workflows\remnote-todo-cli.js',
    [string]$Node = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference = 'Stop'
foreach ($name in @('CODEX_APP_TOOLS_PIPE_PATH','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_SESSION_ID','CODEX_THREAD_ID','CODEX_TOOL_CALL_ID','CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY')) {
    [Environment]::SetEnvironmentVariable($name,$null,'Process')
}
$log = Join-Path (Split-Path -Parent $Config) 'scheduler.log'
$maintenanceExit = 0
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
if ($settings.maintenanceConfigFile) {
    $maintenanceEntry = Join-Path (Split-Path -Parent $Entry) 'remnote-maintenance-cli.js'
    & $Node $maintenanceEntry run $settings.maintenanceConfigFile >> $log 2>&1
    $maintenanceExit = $LASTEXITCODE
}
& $Node $Entry run $Config >> $log 2>&1
if ($maintenanceExit -ne 0) { exit $maintenanceExit }
exit $LASTEXITCODE
