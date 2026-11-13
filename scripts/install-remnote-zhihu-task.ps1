param(
    [string]$Config = 'D:\AppData\WakeWire\workflows\remnote-zhihu\config.json',
    [string]$TaskName = 'WakeWire - RemNote Zhihu Articles'
)
$ErrorActionPreference = 'Stop'
if ((Get-TimeZone).Id -ne 'China Standard Time') { throw 'This schedule requires China Standard Time.' }
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'Workflow configuration is missing.' }
$runner = Join-Path $PSScriptRoot 'run-remnote-zhihu.ps1'
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not ($existing.Actions.Arguments -like ('*'+$runner+'*'))) {
    throw 'Task name is already used by a different program.'
}
$arguments = '-NoLogo -NoProfile -WindowStyle Hidden -File "'+$runner+'" -Config "'+$Config+'"'
# Same direct-process pattern as the RemNote command workflow; preserve real exit codes.
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$now = Get-Date
$triggers = @('11:30', '17:30', '22:30' | ForEach-Object {
    $start = $now.Date.Add([TimeSpan]::Parse($_))
    if ($start -le $now) { $start = $start.AddDays(1) }
    New-ScheduledTaskTrigger -Daily -At $start
})
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
# The CLI also enforces each window. Do not catch up missed publication slots.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
# Registration does not execute a live publication.
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object TaskName,NextRunTime,LastRunTime,LastTaskResult
