// Refs #323: `pnpm check:csp-hashes` existed and had unit tests, but no workflow ran
// the check itself, so a loosened CSP or an edited inline script would ship green. The
// general fact: a root `check:*` or `lint:*` script is a CI gate, and a gate that runs
// in no workflow guards nothing. This fails when one is added without wiring it in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Root scripts that are intentionally not CI gates, with the reason.
const NOT_CI_GATES = {};

function workflowText() {
  const dir = join(ROOT, '.github', 'workflows');
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

test('every root check:* / lint:* script runs in some workflow', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const gates = Object.keys(pkg.scripts).filter((k) => /^(check|lint):/.test(k) && !(k in NOT_CI_GATES));
  assert.ok(gates.includes('check:csp-hashes'), 'expected check:csp-hashes to be a root script');
  const wf = workflowText();
  const missing = gates.filter((s) => {
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`pnpm (run )?${esc}(\\s|$|["'])`, 'm').test(wf);
  });
  assert.deepEqual(missing, [], `root gate scripts not run by any .github/workflows file: ${missing.join(', ')}`);
});
