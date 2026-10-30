param([string]$WakeWireHome = 'D:\AppData\WakeWire', [string]$TaskName = 'WakeWire')
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-windows-service.ps1'
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not ($existing.Actions.Arguments -like ('*'+$runner+'*'))) {
    throw 'Task name is already used by a different program.'
}
$arguments = '--headless "'+$pwsh+'" -NoLogo -NoProfile -WindowStyle Hidden -File "'+$runner+'" -WakeWireHome "'+$WakeWireHome+'"'
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output ('Installed and started '+$TaskName)
