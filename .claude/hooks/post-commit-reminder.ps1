# PostToolUse hook: after any shell command that ran `git commit`, remind the agent to
# push the BRANCH (never main/stable) and run the post-commit review pipeline.
# See CLAUDE.md "Autonomous brainstorming-to-build workflow".
try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
} catch {
    exit 0
}

$cmd = $payload.tool_input.command
if (-not $cmd) { exit 0 }

if ($cmd -match 'git\b[^|;&]*\bcommit\b') {
    $msg = 'A git commit just landed. Per the CLAUDE.md autonomous build workflow: (1) push the current feature/brainstorming BRANCH to origin - never push to or merge into main/stable, that is the human maintainer''s call; (2) run the post-commit-review skill (.claude/skills/post-commit-review) which launches ci-watchdog, security-analyst, stability-reviewer, and best-practices-reviewer in parallel; (3) their findings become automated-review GitHub issues; (4) make addressing open automated-review issues the first order of business for the next coding step (fix each in its own commit with Fixes #<n>, no Co-Authored-By footer).'
    $out = @{
        hookSpecificOutput = @{
            hookEventName     = 'PostToolUse'
            additionalContext = $msg
        }
    } | ConvertTo-Json -Compress -Depth 4
    Write-Output $out
}
exit 0
