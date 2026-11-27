#!/usr/bin/env node
// Fails when any source under apps/*/src or packages/*/src calls z.coerce.boolean() (#251), or
// compares an env flag to a literal by hand, e.g. `process.env.BBB_RLS_ENFORCE === '1'` (#302).
// Use boolQueryParam() for query strings, envBool() in an env.ts schema, or envFlag() outside one,
// all from @bigbluebam/shared (packages/shared/src/schemas/common.ts). Wired into
// .github/workflows/lint.yml.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCoerceBoolean, findRawEnvFlagCompares } from './lib/no-coerce-boolean.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
console.log('check-no-coerce-boolean: scanning apps/*/src and packages/*/src ...');
let failed = false;
const hits = findCoerceBoolean(root);
if (hits.length > 0) {
  console.error(`check-no-coerce-boolean: ${hits.length} z.coerce.boolean() call(s) found. 'false' parses as true there.`);
  console.error("Use boolQueryParam() (query strings) or envBool() (env vars) from '@bigbluebam/shared'.");
  for (const h of hits) console.error(`  ${h}`);
  failed = true;
}
const raw = findRawEnvFlagCompares(root);
if (raw.length > 0) {
  console.error(`check-no-coerce-boolean: ${raw.length} hand-compared env flag(s) found. 'true' / 'yes' / 'on' read as off there.`);
  console.error("Declare the flag with envBool() in env.ts, or read it with envFlag() from '@bigbluebam/shared'.");
  for (const h of raw) console.error(`  ${h}`);
  failed = true;
}
if (failed) process.exit(1);
console.log('check-no-coerce-boolean: OK, no z.coerce.boolean() calls and no hand-compared env flags.');
