param(
    [string]$WakeWireHome = 'D:\AppData\WakeWire',
    [string]$Cli = 'D:\Applications\WakeWire\node_modules\wakewire\dist\cli.js',
    [string]$Node = 'C:\Program Files\nodejs\node.exe'
)
$ErrorActionPreference = 'Stop'
$env:WAKEWIRE_HOME = $WakeWireHome
foreach ($name in @('CODEX_APP_TOOLS_PIPE_PATH','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_SESSION_ID','CODEX_THREAD_ID','CODEX_TOOL_CALL_ID','CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY')) {
    [Environment]::SetEnvironmentVariable($name,$null,'Process')
}
& $Node $Cli start
exit $LASTEXITCODE
