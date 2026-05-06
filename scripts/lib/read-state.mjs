#!/usr/bin/env node
//
// read-state.mjs — print a value from .local-dev-state.json by nested-key path.
//
// Usage:
//   node scripts/lib/read-state.mjs <key> [<key> ...]
//
// Examples:
//   node scripts/lib/read-state.mjs domain
//     → "localhost"
//   node scripts/lib/read-state.mjs devAdmin DEV_ADMIN_EMAIL
//     → "admin@example.com"
//   node scripts/lib/read-state.mjs devAdmin DEV_ADMIN_PASSWORD
//     → "<48-char hex>"
//
// Prints the resolved value to stdout (no trailing newline) or empty
// string if the path doesn't resolve. Does not error on missing keys —
// callers can detect missing values with a simple [ -z "$VAR" ] check.
// Errors only on a malformed JSON state file.
//
// Designed to be called from bash (provision-admin.sh, fixture-base.sh)
// without pulling in jq as a dependency. Node is already required by the
// dev pipeline (configure.sh, up.sh).

import * as fs from 'node:fs';

const STATE_FILE = '.local-dev-state.json';

const keys = process.argv.slice(2);
if (keys.length === 0) {
  console.error('usage: node scripts/lib/read-state.mjs <key> [<key> ...]');
  process.exit(2);
}

if (!fs.existsSync(STATE_FILE)) {
  // Silent — emit nothing; caller's empty-check handles "missing state."
  process.exit(0);
}

let state;
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch (err) {
  console.error(`[read-state] failed to parse ${STATE_FILE}: ${err.message}`);
  process.exit(1);
}

let value = state;
for (const key of keys) {
  if (value == null) break;
  value = value[key];
}

if (value == null) process.exit(0);
process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
