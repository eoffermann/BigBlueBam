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
    re: /FROM\s+api_keys\b[^;`]*?\bkey_prefix\s*=|\bauth_api_key_candidates\s*\(|\bauth_api_key_legacy_candidates\s*\(/,
  },
  // #353: the lookup-id read/adopt and the lookup derivation live once.
  {
    what: 'a private api_keys lookup-id read or adopt (use sqlApiKeyStore from @bigbluebam/auth-core)',
    re: /\bauth_api_key_by_lookup\s*\(|\bauth_adopt_api_key_lookup\s*\(|FROM\s+api_keys\b[^;`]*?\bkey_lookup\s*=/,
  },
  {
    what: 'a private API-key scope ordering (use API_KEY_SCOPES / scopeAtLeast)',
    re: /\[\s*'read'\s*,\s*'read_write'\s*,\s*'admin'\s*\]/,
  },
  {
    what: 'a private org-admin role set (use ORG_ADMIN_ROLES)',
    re: /new Set\(\s*\[\s*'(?:admin|owner)'\s*,\s*'(?:admin|owner)'\s*\]\s*\)/,
  },
  // #350: org-context resolution (memberships, roles, soft-deleted orgs, X-Org-Id parsing).
  {
    what: 'a private resolveOrgContext (use resolveOrgContext + sqlOrgContextStore from @bigbluebam/auth-core)',
    re: /\bfunction\s+resolveOrgContext\b|\b(?:const|let)\s+resolveOrgContext\s*=/,
  },
  {
    what: 'a private X-Org-Id parser (use requestedOrgIdFromHeader from @bigbluebam/auth-core)',
    re: /\bfunction\s+getRequestedOrgId\b/,
  },
  {
    what: 'a private OrgMembershipError (import it from @bigbluebam/auth-core)',
    re: /\bclass\s+OrgMembershipError\b/,
  },
  {
    what: 'a private call to the 0311 identity functions (use sqlOrgContextStore from @bigbluebam/auth-core)',
    re: /\bauth_user_live_memberships\s*\(|\bauth_user_org_roles\s*\(|\bauth_org_is_live\s*\(/,
  },
];

// #350: an auth plugin must not read the membership tables itself. Pre-auth, under
// BBB_RLS_ENFORCE=1, those reads are org-gated and return nothing, and they skip the
// soft-deleted-org rule that lives in auth_user_live_memberships.
const AUTH_PLUGIN_RULES = [
  {
    what: 'a direct membership-table read in an auth plugin (use resolveOrgContext from @bigbluebam/auth-core)',
    re: /\.from\(\s*(?:organizationMemberships|accountGroupMemberships)\s*\)|\bFROM\s+(?:organization_memberships|account_group_memberships)\b/i,
  },
];

// Files allowed to carry one of the literals for a reason unrelated to key verification.
const EXEMPT = new Map([
  // The scope list itself is declared once here (client and server share it); auth-core re-exports it.
  [
    `packages${sep}shared${sep}src${sep}constants${sep}index.ts`,
    new Set([RULES.findIndex((r) => r.what.startsWith('a private API-key scope ordering'))]),
  ],
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
      if (rel.endsWith(`${sep}plugins${sep}auth.ts`)) {
        for (const rule of AUTH_PLUGIN_RULES) {
          if (rule.re.test(text)) offenders.push(`${rel}: ${rule.what}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `Use @bigbluebam/auth-core instead of a local copy:\n${offenders.join('\n')}`);
});

// #353: a key minted without key_lookup lands in the legacy prefix bucket forever (until first
// use). Every drizzle insert into api_keys under apps/*/src must store apiKeyLookup(token).
test('every api_keys mint path stores key_lookup', () => {
  const missing = [];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const src = join(ROOT, 'apps', app, 'src');
    try {
      statSync(src);
    } catch {
      continue;
    }
    for (const file of walk(src)) {
      const text = readFileSync(file, 'utf8');
      const re = /\.insert\(\s*apiKeys\s*\)\s*\.values\(\s*\{([\s\S]*?)\}\s*\)/g;
      for (const m of text.matchAll(re)) {
        if (!/\bkey_lookup\s*:\s*apiKeyLookup\(/.test(m[1])) {
          const line = text.slice(0, m.index).split('\n').length;
          missing.push(`${relative(ROOT, file)}:${line}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], `Store key_lookup: apiKeyLookup(token) on every api_keys insert:\n${missing.join('\n')}`);
});

// #352: an API key's project restriction is enforced once, from auth-core. Every satellite that
// accepts bbam_ keys refuses a project-restricted one (it has no Bam project to confine it to),
// and apps/api appends the fail-closed final gate to every route.
test('every service that accepts bbam_ keys enforces the key project restriction', () => {
  const missing = [];
  for (const app of readdirSync(join(ROOT, 'apps'))) {
    const auth = join(ROOT, 'apps', app, 'src', 'plugins', 'auth.ts');
    let text = '';
    try {
      text = readFileSync(auth, 'utf8');
    } catch {
      continue;
    }
    if (!/\bBearer\b/.test(text) || !/verifyApiKeyToken\(/.test(text)) continue;
    const ok =
      app === 'api'
        ? /requireKeyProjectChecked/.test(text) && /api_key_project_ids\s*=\s*keyProjectRestriction\(/.test(text)
        : /refuseProjectRestrictedKey\(\s*request\s*,\s*reply\s*,\s*verified\.apiKey\.project_ids\s*\)/.test(text);
    if (!ok) missing.push(app);
  }
  assert.deepEqual(missing, [], `Enforce api_keys.project_ids via @bigbluebam/auth-core in:\n${missing.join('\n')}`);
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
