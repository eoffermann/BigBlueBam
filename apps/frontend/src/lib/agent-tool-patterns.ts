/**
 * A project-restricted agent key can only use Bam tools for its projects (#367): every other app
 * refuses a project-restricted key outright, because it has no Bam project to confine it to.
 * Bam's own MCP tools carry no app prefix (create_task, list_tasks, ...); every other app's tools
 * do (banter_*, bond_get_*, ...). This finds the allowlist patterns that name another app, so the
 * Settings > Agents form can warn before creating an agent that could never use them.
 */
const OTHER_APP_PREFIXES = [
  'banter',
  'basis',
  'bastion',
  'bay',
  'beacon',
  'bearing',
  'bench',
  'bill',
  'bin',
  'blank',
  'blast',
  'blip',
  'blueprint',
  'board',
  'bolt',
  'bond',
  'book',
  'braid',
  'brief',
  'bulwark',
  'bureau',
  'burn',
  'bursar',
  'helpdesk',
];

/** The patterns (trimmed, non-empty lines) that target an app other than Bam. */
export function nonBamToolPatterns(patterns: string): string[] {
  return patterns
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => {
      const lower = p.toLowerCase();
      return lower === '*' || OTHER_APP_PREFIXES.some((app) => lower === `${app}*` || lower.startsWith(`${app}_`));
    });
}
