#!/usr/bin/env node
// Regenerates the can_access MCP tool description in
// apps/mcp-server/src/tools/visibility-tools.ts from the ONE entity-type allowlist,
// VISIBILITY_ENTITY_TYPES in packages/shared/src/visibility-entity-types.ts.
//
// The description stays a string literal in the tool file because the tool-schema extractor
// (scripts/extract-mcp-tool-schemas.mjs) and the docs catalog (scripts/docs/lib/tool-source.mjs)
// read descriptions statically. apps/mcp-server/test/visibility-tools.test.ts fails when the
// literal and canAccessToolDescription() disagree, so drift is caught in CI.
//
//   node scripts/gen-can-access-description.mjs          rewrite the literal
//   node scripts/gen-can-access-description.mjs --check  exit 1 when it is stale

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST_FILE = join(ROOT, 'packages/shared/src/visibility-entity-types.ts');
const TOOL_FILE = join(ROOT, 'apps/mcp-server/src/tools/visibility-tools.ts');

const listSrc = readFileSync(LIST_FILE, 'utf8');
const block = listSrc.match(/export const VISIBILITY_ENTITY_TYPES = \[([\s\S]*?)\] as const;/);
if (!block) {
  console.error('gen-can-access-description: VISIBILITY_ENTITY_TYPES not found');
  process.exit(1);
}
const types = [...block[1].matchAll(/^\s*'([a-z_]+\.[a-z_]+)',/gm)].map((m) => m[1]);
if (types.length === 0) {
  console.error('gen-can-access-description: no entity types parsed');
  process.exit(1);
}

// Must match canAccessToolDescription() in packages/shared/src/visibility-entity-types.ts.
const lead =
  'Preflight a visibility check. Returns { allowed, reason } for whether asker_user_id can see (entity_type, entity_id). Agents that surface cross-app results into shared channels MUST call this for every cited entity and filter out anything that is not allowed.';
const tail = "Unsupported types return reason='unsupported_entity_type' (with a supported_entity_types hint) and MUST NOT be surfaced.";
const description = `${lead} Supported entity_type values: ${types.join(', ')}. ${tail}`;

const toolSrc = readFileSync(TOOL_FILE, 'utf8');
const re = /(name: 'can_access',\s*description:\s*)"[^"\n]*"/;
if (!re.test(toolSrc)) {
  console.error('gen-can-access-description: the can_access description literal was not found');
  process.exit(1);
}
const next = toolSrc.replace(re, `$1${JSON.stringify(description)}`);
if (process.argv.includes('--check')) {
  if (next !== toolSrc) {
    console.error('gen-can-access-description: the can_access description is stale; run node scripts/gen-can-access-description.mjs');
    process.exit(1);
  }
  console.log(`OK: can_access description lists ${types.length} entity types.`);
} else {
  writeFileSync(TOOL_FILE, next);
  console.log(`can_access description regenerated (${types.length} entity types).`);
}
