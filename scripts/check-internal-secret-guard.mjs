#!/usr/bin/env node
// #252: every internal (server-to-server) route authenticates through the one shared guard in
// packages/service-health/src/internal-secret.ts (createInternalSecretGuard: constant-time compare,
// fails closed, direct private-network peers only). This check fails when service code reads an
// internal-secret header itself, which is how the per-service copies (and their drift: plain !==,
// fail-open when unconfigured, no peer check) kept coming back. Wired into lint.yml.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findInternalSecretHeaderReads } from './lib/internal-secret-guard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
console.log('check-internal-secret-guard: scanning apps/*/src and packages/*/src ...');
const hits = findInternalSecretHeaderReads(root);
if (hits.length > 0) {
  console.error(`check-internal-secret-guard: ${hits.length} direct read(s) of an internal-secret header.`);
  console.error("Use createInternalSecretGuard (or sameSecret + refuseNonPrivatePeer) from '@bigbluebam/service-health'.");
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log('check-internal-secret-guard: OK, every internal-secret header is read by the shared guard.');
