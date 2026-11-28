// node --test scripts/deploy/shared/mcp-needs.nodetest.mjs
// (named *.nodetest.mjs so the vitest suite in this directory does not collect it)
//
// #417: mcp-server holds a base URL for every satellite API it calls (apps/mcp-server/src/env.ts).
// Its deploy-catalog `needs` must name each of those services. The catalog derives `needs` from
// MCP_SERVICE_URL_VARS, so this test pins that map to what env.ts actually reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SERVICES, MCP_SERVICE_URL_VARS, findService } from './services.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_TS = readFileSync(join(ROOT, 'apps', 'mcp-server', 'src', 'env.ts'), 'utf8');

/** Every `NAME_API_URL` / `API_INTERNAL_URL` key in env.ts with its default URL's host. */
function envUrlVars(src) {
  const out = new Map();
  const re = /^\s*([A-Z][A-Z0-9_]*_API_URL|API_INTERNAL_URL):\s*z\.string\(\)\.url\(\)(?:\.default\('([^']*)'\))?/gm;
  for (const m of src.matchAll(re)) {
    out.set(m[1], m[2] ? new URL(m[2]).hostname : null);
  }
  return out;
}

const mcp = APP_SERVICES.find((s) => s.name === 'mcp-server');
const vars = envUrlVars(ENV_TS);

test('env.ts parsing finds the URL vars', () => {
  assert.ok(vars.size >= 20, `expected the satellite URL roster, found ${vars.size}`);
  assert.ok(vars.has('BASTION_API_URL'));
});

test('every service URL mcp-server reads is in MCP_SERVICE_URL_VARS and in its needs', () => {
  const problems = [];
  for (const [name, host] of vars) {
    const service = MCP_SERVICE_URL_VARS[name];
    if (!service) {
      problems.push(`${name} is read by mcp-server but missing from MCP_SERVICE_URL_VARS`);
      continue;
    }
    if (!findService(service)) problems.push(`${name} maps to ${service}, which is not in the catalog`);
    if (!mcp.needs.includes(service)) problems.push(`${service} (${name}) missing from mcp-server needs`);
    // A default pointing at a compose hostname must agree with the map (localhost defaults are dev-only).
    if (host && host !== 'localhost' && host !== service) problems.push(`${name} defaults to host ${host}, map says ${service}`);
    const listed = [...mcp.env.required, ...mcp.env.optional];
    if (!listed.includes(name)) problems.push(`${name} missing from mcp-server env lists`);
  }
  assert.deepEqual(problems, []);
});

test('MCP_SERVICE_URL_VARS carries no var env.ts does not read', () => {
  const stale = Object.keys(MCP_SERVICE_URL_VARS).filter((k) => !vars.has(k));
  assert.deepEqual(stale, []);
});

test('the satellites the close-out audit found missing are now needed', () => {
  for (const s of ['bastion-api', 'basis-api', 'braid-api', 'bulwark-api', 'burn-api', 'bursar-api', 'bureau-api']) {
    assert.ok(mcp.needs.includes(s), s);
  }
  assert.ok(mcp.needs.includes('redis'));
});
