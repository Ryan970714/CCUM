# One-time setup: registers a Windows Scheduled Task that starts the usage watcher
# hidden (no console window) at every logon, and starts it immediately.
#
# Run manually once, in an elevated-or-not PowerShell (no admin rights required for a
# per-user logon task):
#   powershell -ExecutionPolicy Bypass -File install-task.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VbsPath = Join-Path $ScriptDir "run-watcher.vbs"
$TaskName = "ClaudeUsageWatcher"

if (-not (Test-Path $VbsPath)) {
    throw "run-watcher.vbs not found next to install-task.ps1 ($VbsPath)"
}

$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$VbsPath`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Task '$TaskName' already exists — unregistering old copy first."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
    -Settings $Settings -Description "Watches Claude Code JSONL transcripts and syncs usage to the cc-usage-dashboard Worker." | Out-Null

Write-Host "Registered scheduled task '$TaskName' (triggers at logon)."

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Started. LastTaskResult=$($info.LastTaskResult) LastRunTime=$($info.LastRunTime)"
Write-Host ""
Write-Host "Check it's actually running with:  Get-Process node | Select-Object Id,StartTime,Path"
Write-Host "Watch its log with:                Get-Content watcher.log -Wait -Tail 20"
