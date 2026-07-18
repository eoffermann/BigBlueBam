<#
.SYNOPSIS
  Register (or re-register) the Windows Task Scheduler job that runs the
  BigBlueBam autonomous "Startup in a Box" cycle every 6 hours.

.DESCRIPTION
  Idempotent: unregisters any existing task of the same name, then creates a
  fresh one. Runs run-autonomous-cycle.ps1 headless via PowerShell.

  Logon type S4U: the task runs whether or not the user is interactively
  logged on, and needs NO stored password. The repo lives on a LOCAL disk
  (H:, DriveType=3) so S4U's lack of network-share access is not a problem;
  outbound HTTPS (the Anthropic API) works fine under S4U.

  Schedule: anchored at 20:00 today, repeating every 6 hours indefinitely
  (fires ~20:00, 02:00, 08:00, 14:00). Change $AnchorHour to move the anchor.

.NOTES
  Run this once from an ELEVATED PowerShell (Task Scheduler registration for
  "run whether logged on or not" requires admin). Re-run any time to update.
#>

$ErrorActionPreference = 'Stop'

$TaskName   = 'BigBlueBam Autonomous Cycle'
$RepoRoot   = 'H:\BigBlueBam'
$Wrapper    = Join-Path $RepoRoot 'scripts\autonomous\run-autonomous-cycle.ps1'
$AnchorHour = 20   # 8 PM local anchor; repeats every 6h from here
$IntervalHours = 6

if (-not (Test-Path $Wrapper)) { throw "wrapper not found: $Wrapper" }

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$action = New-ScheduledTaskAction `
  -Execute $psExe `
  -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $Wrapper) `
  -WorkingDirectory $RepoRoot

# -Once at today's anchor + repetition every 6h, indefinitely.
$anchor = (Get-Date).Date.AddHours($AnchorHour)
$trigger = New-ScheduledTaskTrigger -Once -At $anchor `
  -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)

# Run as the current user, highest privileges, without a stored password (S4U),
# whether or not the user is logged on.
$principal = New-ScheduledTaskPrincipal `
  -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) `
  -LogonType S4U `
  -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 5 -Minutes 45) `
  -RestartCount 0

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Output "Unregistering existing task '$TaskName' ..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'BigBlueBam Startup-in-a-Box: runs one full autonomous brainstorm -> build -> deploy -> test cycle every 6 hours on the suite-brainstorm branch. Never merges to main.' | Out-Null

Write-Output "Registered '$TaskName'."
$t = Get-ScheduledTask -TaskName $TaskName
$info = $t | Get-ScheduledTaskInfo
Write-Output ("State: {0}" -f $t.State)
Write-Output ("Next run: {0}" -f $info.NextRunTime)
Write-Output ("Anchor: {0}, every {1}h" -f $anchor, $IntervalHours)
