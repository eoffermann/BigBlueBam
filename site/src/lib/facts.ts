// Product facts shown on the site. Each one is checked against the code in CI,
// so a stale number fails the build instead of shipping.
import docsCatalog from '../content/docs-catalog.generated.json';

/**
 * MCP tools registered by apps/mcp-server (one registerTool() call each).
 * Checked by scripts/check-tool-return-coverage.mjs.
 */
export const MCP_TOOL_COUNT = 885;

/**
 * Apps on the Launchpad. Derived from the generated /docs catalog, which
 * `pnpm docs:catalog:check` keeps equal to LAUNCHPAD_CATALOG in CI. The
 * "platform" entry is the cross-app MCP layer, not an app.
 */
export const APP_COUNT: number = (docsCatalog as { id: string }[]).filter(
  (p) => p.id !== 'platform',
).length;

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function toWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  return String(n);
}

/** APP_COUNT spelled out for prose ("twenty-four"). */
export const APP_COUNT_WORDS = toWords(APP_COUNT);
