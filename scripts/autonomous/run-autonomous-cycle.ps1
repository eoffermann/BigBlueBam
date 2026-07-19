<#
.SYNOPSIS
  Windows Task Scheduler entry point for the BigBlueBam "Startup in a Box"
  autonomous cycle. Launches Claude Code headless to run ONE full
  brainstorm -> spec-harden -> build -> deploy -> test cycle on the
  suite-brainstorm branch. Never merges to main (the cycle enforces that).

.NOTES
  Registered by scripts/autonomous/register-autonomous-task.ps1 to run every
  6 hours, independent of any interactive Claude session. Emits flushed
  progress to a per-run log so a stalled run is obvious. A process-level lock
  prevents two headless cycles from overlapping if one run overruns the window
  (the cycle skill also keeps its own scratchpad lock).
#>

$ErrorActionPreference = 'Stop'
$RepoRoot   = 'H:\BigBlueBam'
$ClaudeExe  = 'C:\Users\eoffe\.local\bin\claude.exe'
$LogDir     = Join-Path $RepoRoot '.autonomous-logs'
$LockFile   = Join-Path $LogDir 'cycle.lock'
$Prompt     = 'Use the autonomous-cycle skill to run one full Startup-in-a-Box cycle now: brainstorm and harden a new app spec, then build, deploy to the local Docker dev stack, and test it, all on the suite-brainstorm branch. Never merge to main.'

# Roughly the window length minus a margin; a run may not outlive its window.
$MaxRunAgeHours = 5.75

function Log([string]$msg) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  Write-Output $line
  if ($script:RunLog) { Add-Content -Path $script:RunLog -Value $line -Encoding utf8 }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$script:RunLog = Join-Path $LogDir ("cycle_$stamp.log")

Log "=== autonomous cycle wrapper starting (pid $PID) ==="
Log "repo=$RepoRoot log=$RunLog"

# --- Overlap guard -----------------------------------------------------------
if (Test-Path $LockFile) {
  $lockAgeH = ((Get-Date) - (Get-Item $LockFile).LastWriteTime).TotalHours
  if ($lockAgeH -lt $MaxRunAgeHours) {
    Log ("previous cycle lock is {0:N1}h old (< {1}h); a run is likely still active - SKIPPING this window." -f $lockAgeH, $MaxRunAgeHours)
    exit 0
  }
  Log ("stale lock {0:N1}h old (>= {1}h) - taking it over." -f $lockAgeH, $MaxRunAgeHours)
  Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
}
Set-Content -Path $LockFile -Value $stamp -Encoding utf8

try {
  Set-Location $RepoRoot

  # Docker Desktop is needed for the deploy/test phases. Warn but do NOT abort:
  # the cycle still brainstorms, hardens the spec, and builds/typechecks, and it
  # writes a HUMAN_SETUP note for anything it cannot finish unattended.
  $docker = Get-Process -Name 'com.docker.backend','Docker Desktop' -ErrorAction SilentlyContinue
  if (-not $docker) {
    Log 'WARNING: Docker Desktop does not appear to be running; deploy/test phases may be skipped by the cycle.'
  } else {
    Log 'Docker Desktop detected.'
  }

  Log 'launching Claude Code headless (this is a long run; expect a lengthy quiet period during brainstorm + build) ...'
  $cliLog = Join-Path $LogDir ("claude_$stamp.log")

  # A cycle spawns background agents (spec-writer, five adversaries, per-milestone
  # builders) that legitimately run far longer than the CLI's default 600s
  # background-task ceiling. Without this, `claude -p` prints its foreground result,
  # waits 600s, then TERMINATES the run while those agents are still working - which
  # killed the 2026-07-18 20:00 Bulwark cycle mid spec-draft. 0 = wait indefinitely
  # for background tasks, so the whole brainstorm+build can complete headless.
  $env:CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0'

  # Headless, unattended: bypass permission prompts (no human present) and stream
  # the transcript to a log. Working dir is the repo so the cycle acts on it.
  & $ClaudeExe -p $Prompt `
      --dangerously-skip-permissions `
      --add-dir $RepoRoot `
      *>&1 | Tee-Object -FilePath $cliLog

  $code = $LASTEXITCODE
  Log "claude exited with code $code (transcript: $cliLog)"
}
catch {
  Log ("ERROR: " + $_.Exception.Message)
}
finally {
  Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
  Log '=== autonomous cycle wrapper finished ==='
}
