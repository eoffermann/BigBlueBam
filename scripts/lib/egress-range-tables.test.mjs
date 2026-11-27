// #328: the "which addresses are private" fact lives only in packages/egress-guard.
// Before the package the suite grew four copies of the range table (literal-IP only,
// no DNS resolution), and each copy that lagged was a live SSRF gap. This guard fails
// when a private-IP range table or SSRF validator appears anywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage', '.git']);
const ALLOWED_PREFIX = `packages${sep}egress-guard${sep}`;

// Signatures of a hand-rolled range table or validator.
const PATTERNS = [
  /\b(?:BLOCKED|PRIVATE|ALWAYS_BLOCKED)_IPV4_RANGES\b/,
  /start:\s*\[\s*169\s*,\s*254\s*,/,
  /\bfunction\s+validateExternalUrl\b/,
  /\bfunction\s+validateWebhookUrl\b/,
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(name)) yield full;
  }
}

test('no private-IP range table or SSRF validator outside packages/egress-guard', () => {
  const offenders = [];
  for (const top of ['apps', 'packages']) {
    for (const file of walk(join(ROOT, top))) {
      const rel = relative(ROOT, file);
      if (rel.startsWith(ALLOWED_PREFIX)) continue;
      const text = readFileSync(file, 'utf8');
      for (const re of PATTERNS) {
        if (re.test(text)) offenders.push(`${rel} (${re.source})`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Use @bigbluebam/egress-guard instead of a local copy:\n${offenders.join('\n')}`);
});
