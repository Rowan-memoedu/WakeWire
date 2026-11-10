param(
    [string]$Config = 'D:\AppData\WakeWire\workflows\remnote-todo\config.json',
    [string]$TaskName = 'WakeWire - RemNote Todo 0200'
)
$ErrorActionPreference = 'Stop'
if ((Get-TimeZone).Id -ne 'China Standard Time') { throw 'This schedule requires China Standard Time.' }
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'Workflow configuration is missing.' }
$runner = Join-Path $PSScriptRoot 'run-remnote-todo.ps1'
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not ($existing.Actions.Arguments -like ('*'+$runner+'*'))) {
    throw 'Task name is already used by a different program.'
}
$arguments = '-NoLogo -NoProfile -WindowStyle Hidden -File "'+$runner+'" -Config "'+$Config+'"'
# Run the real process so Task Scheduler receives its exit code; headless
# conhost reports its own success even when the child workflow has failed.
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$now = Get-Date
$triggers = @(2, 11, 17 | ForEach-Object {
    $start = $now.Date.AddHours($_)
    if ($start -le $now) { $start = $start.AddDays(1) }
    New-ScheduledTaskTrigger -Daily -At $start
})
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 23) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
# Registration never runs the live document. First dispatch occurs at the saved next trigger.
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object TaskName,NextRunTime,LastRunTime,LastTaskResult
