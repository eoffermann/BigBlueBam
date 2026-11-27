// #340: the bbam_ API-key rules live only in packages/auth-core. Before it, ~25 Fastify
// services each carried a private requireScope (21 of them without the #336 org-role check)
// and a private copy of the key verification (most without rotation grace, the bbam_svc
// bucket, the Argon2 throw guard or the org pin). Every copy that lagged was a live gap.
// This guard fails when any of those facts is defined again outside packages/auth-core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage', '.git', 'test', '__tests__']);
const ALLOWED_PREFIX = `packages${sep}auth-core${sep}`;

const RULES = [
  {
    what: 'a private requireScope (import it from @bigbluebam/auth-core)',
    re: /\bexport\s+(?:async\s+)?function\s+requireScope\b|\b(?:const|let)\s+requireScope\s*=/,
  },
  {
    what: 'a private bbam_ key hash check (use verifyApiKeyToken from @bigbluebam/auth-core)',
    re: /\bapiKey\.key_hash\b|\bverify\(\s*String\(\s*\w+\.key_hash\s*\)/,
  },
  {
    what: 'a private api_keys candidate lookup by prefix (use sqlApiKeyStore from @bigbluebam/auth-core)',
    re: /FROM\s+api_keys\b[^;`]*?\bkey_prefix\s*=|\bauth_api_key_candidates\s*\(/,
  },
  {
    what: 'a private API-key scope ordering (use API_KEY_SCOPES / scopeAtLeast)',
    re: /\[\s*'read'\s*,\s*'read_write'\s*,\s*'admin'\s*\]/,
  },
  {
    what: 'a private org-admin role set (use ORG_ADMIN_ROLES)',
    re: /new Set\(\s*\[\s*'(?:admin|owner)'\s*,\s*'(?:admin|owner)'\s*\]\s*\)/,
  },
  // #351: helpdesk-api's two Bam-key guards re-derived requireScope from these primitives (a
  // method-based scope check, an inline role-cap exemption) and drifted from it in three ways,
  // passing every rule above. A scope gate is scopeDecision / orgAdminSurfaceDecision /
  // requireScope from auth-core; calling the primitives directly is how a copy starts.
  {
    what: 'a hand-rolled scope gate (use requireScope / scopeDecision / scopeForMethod from @bigbluebam/auth-core)',
    re: /\bscopeAtLeast\(\s*[\w.!?]/,
  },
  {
    what: 'a hand-rolled #336 role cap (use requireScope / scopeDecision / orgAdminSurfaceDecision)',
    re: /\bkeyRoleCapApplies\(\s*[\w.!?]/,
  },
  {
    what: 'a hand-rolled P2-8 org pin (use isApiKeyOrgPinned / keyActingOrgId / applyKeyOrgPin)',
    re: /\b(?:keyOrgId|apiKey\.org_id)\s*\?\?\s*\(?\s*await\b|!\s*\w+\.isSuperuser\s*&&\s*\w+\.keyOrgId\b/,
  },
];

const SCOPE_GATE_RULE = RULES.findIndex((r) => r.what.startsWith('a hand-rolled scope gate'));

// Files allowed to carry one of the literals for a reason unrelated to key verification.
const EXEMPT = new Map([
  // The scope list itself is declared once here (client and server share it); auth-core re-exports it.
  [`packages${sep}shared${sep}src${sep}constants${sep}index.ts`, new Set([3])],
  // Minting ceilings, not route gates: a caller may only mint a key (or service-account key)
  // whose scope does not exceed its own.
  [`apps${sep}api${sep}src${sep}routes${sep}api-key.routes.ts`, new Set([SCOPE_GATE_RULE])],
  [`apps${sep}api${sep}src${sep}routes${sep}service-account.routes.ts`, new Set([SCOPE_GATE_RULE])],
]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(name) && !/\.test\.[cm]?[jt]sx?$/.test(name)) yield full;
  }
}

test('bbam_ key verification and requireScope are defined only in packages/auth-core', () => {
  const offenders = [];
  // Server code only: the Fastify services, the worker, the MCP server, and the shared packages.
  // SPAs never verify a key; their display-side role/scope lists are not authorization.
  const roots = [
    ...readdirSync(join(ROOT, 'apps'))
      .filter((a) => /^(?:api|worker|mcp-server)$|-api$/.test(a))
      .map((a) => join(ROOT, 'apps', a, 'src')),
    join(ROOT, 'packages'),
  ];
  for (const top of roots) {
    let exists = true;
    try {
      statSync(top);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    for (const file of walk(top)) {
      const rel = relative(ROOT, file);
      if (rel.startsWith(ALLOWED_PREFIX)) continue;
      const text = readFileSync(file, 'utf8');
      RULES.forEach((rule, i) => {
        if (EXEMPT.get(rel)?.has(i)) return;
        if (rule.re.test(text)) offenders.push(`${rel}: ${rule.what}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `Use @bigbluebam/auth-core instead of a local copy:\n${offenders.join('\n')}`);
});

test('every service that verifies bbam_ keys depends on @bigbluebam/auth-core', () => {
  const missing = [];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const auth = join(ROOT, 'apps', app, 'src', 'plugins', 'auth.ts');
    let uses = false;
    try {
      uses = /\bBearer\b/.test(readFileSync(auth, 'utf8'));
    } catch {
      continue;
    }
    if (!uses) continue;
    const pkg = JSON.parse(readFileSync(join(ROOT, 'apps', app, 'package.json'), 'utf8'));
    if (!pkg.dependencies?.['@bigbluebam/auth-core']) missing.push(app);
  }
  assert.deepEqual(missing, [], `Add "@bigbluebam/auth-core": "workspace:*" to:\n${missing.join('\n')}`);
});
