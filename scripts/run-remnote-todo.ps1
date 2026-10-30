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
& $Node $Entry run $Config >> $log 2>&1
exit $LASTEXITCODE
