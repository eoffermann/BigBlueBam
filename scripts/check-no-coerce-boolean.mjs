#!/usr/bin/env node
// Fails when any source under apps/*/src or packages/*/src calls z.coerce.boolean() (#251).
// Use boolQueryParam() for query strings or envBool() for environment variables, both from
// @bigbluebam/shared (packages/shared/src/schemas/common.ts). Wired into .github/workflows/lint.yml.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCoerceBoolean } from './lib/no-coerce-boolean.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
console.log('check-no-coerce-boolean: scanning apps/*/src and packages/*/src ...');
const hits = findCoerceBoolean(root);
if (hits.length > 0) {
  console.error(`check-no-coerce-boolean: ${hits.length} z.coerce.boolean() call(s) found. 'false' parses as true there.`);
  console.error("Use boolQueryParam() (query strings) or envBool() (env vars) from '@bigbluebam/shared'.");
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log('check-no-coerce-boolean: OK, no z.coerce.boolean() calls.');
