#!/usr/bin/env node
// Wave F audit — direct resolver probe against /internal/permissions/dual-read.

import { execSync } from 'node:child_process';

const SECRET = execSync('docker compose exec -T api printenv INTERNAL_SERVICE_SECRET', { encoding: 'utf8' }).trim();

// Disable TLS verify for self-signed dev cert
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const USERS = {
  eddie: { id: '65429e63-65c7-4f74-a19e-977217128edc', org_id: '57158e52-227d-4903-b0d8-d9f3c4910f61', role: 'owner+admin (SU)' },
  avery: { id: '969d36a7-a10d-4a64-99dc-f2a95fe2b038', org_id: '57158e52-227d-4903-b0d8-d9f3c4910f61', role: 'member' },
  casey: { id: 'dd98bdfe-7ee4-4bd3-b6ee-70fb8fc0efc8', org_id: '57158e52-227d-4903-b0d8-d9f3c4910f61', role: 'viewer' },
  drew:  { id: '0d79e8fa-d206-4f0a-90df-5669e9fab286', org_id: '57158e52-227d-4903-b0d8-d9f3c4910f61', role: 'guest' },
};

const PROBES = [
  // Personal self-care
  { p: 'platform.user.get_profile', cat: 'self-care', exp: { eddie: 'allow', avery: 'allow', casey: 'allow', drew: 'allow' } },
  { p: 'platform.user.change_password', cat: 'self-care', exp: { eddie: 'allow', avery: 'allow', casey: 'allow', drew: 'allow' } },
  { p: 'platform.user.logout', cat: 'self-care', exp: { eddie: 'allow', avery: 'allow', casey: 'allow', drew: 'allow' } },
  { p: 'platform.user.update_profile', cat: 'self-care', exp: { eddie: 'allow', avery: 'allow', casey: 'allow', drew: 'deny' } },
  // Read verbs
  { p: 'bam.task.get', cat: 'read', exp: { eddie: 'allow', avery: 'allow', casey: 'allow', drew: 'allow' } },
  { p: 'bam.project.list', cat: 'read', exp: { eddie: 'allow', avery: 'allow', casey: 'allow', drew: 'deny' } },
  { p: 'bam.user.list', cat: 'read', exp: { eddie: 'allow', avery: 'allow', casey: 'allow', drew: 'deny' } },
  { p: 'bam.label.list', cat: 'read', exp: { eddie: 'allow', avery: 'allow', casey: 'allow', drew: 'allow' } },
  // Write verbs (member+)
  { p: 'bam.task.create', cat: 'write', exp: { eddie: 'allow', avery: 'allow', casey: 'deny', drew: 'deny' } },
  { p: 'bam.comment.create', cat: 'write', exp: { eddie: 'allow', avery: 'allow', casey: 'deny', drew: 'allow' } },
  { p: 'bam.task.update', cat: 'write', exp: { eddie: 'allow', avery: 'allow', casey: 'deny', drew: 'deny' } },
  // Destructive (admin+)
  { p: 'bam.task.delete', cat: 'destructive', exp: { eddie: 'allow', avery: 'allow', casey: 'deny', drew: 'deny' } },
  { p: 'bam.project.delete', cat: 'destructive', exp: { eddie: 'allow', avery: 'deny', casey: 'deny', drew: 'deny' } },
  // Admin surfaces
  { p: 'bam.audit_log.list', cat: 'admin', exp: { eddie: 'allow', avery: 'deny', casey: 'deny', drew: 'deny' } },
  { p: 'bam.llm_provider.update', cat: 'admin', exp: { eddie: 'allow', avery: 'deny', casey: 'deny', drew: 'deny' } },
  { p: 'agent.policy.set', cat: 'admin', exp: { eddie: 'allow', avery: 'deny', casey: 'deny', drew: 'deny' } },
  // Owner-only
  { p: 'bam.org.update', cat: 'owner-only', exp: { eddie: 'allow', avery: 'deny', casey: 'deny', drew: 'deny' } },
  { p: 'bam.org_member_transfer_ownership.create', cat: 'owner-only', exp: { eddie: 'allow', avery: 'deny', casey: 'deny', drew: 'deny' } },
  // SU-only
  { p: 'bam.platform_org.list', cat: 'su-only', exp: { eddie: 'allow', avery: 'deny', casey: 'deny', drew: 'deny' } },
  { p: 'bam.system_setting.update', cat: 'su-only', exp: { eddie: 'allow', avery: 'deny', casey: 'deny', drew: 'deny' } },
  { p: 'bam.superuser_permission_group.list', cat: 'su-only', exp: { eddie: 'allow', avery: 'deny', casey: 'deny', drew: 'deny' } },
  // Always permitted
  { p: 'agent.self.heartbeat', cat: 'always-permitted', exp: { eddie: 'allow', avery: 'allow', casey: 'allow', drew: 'allow' } },
];

async function probe(userId, permission, orgId) {
  const body = JSON.stringify({
    user_id: userId,
    permission_id: permission,
    scope: { org_id: orgId, project_id: null },
  });
  const resp = await fetch('https://localhost/b3/api/internal/permissions/dual-read', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': SECRET,
    },
    body,
  });
  const data = await resp.json();
  return data.data || { decision: 'error', reason: JSON.stringify(data) };
}

const results = [];
let mismatches = 0;
let total = 0;

for (const probeSpec of PROBES) {
  const row = { permission: probeSpec.p, category: probeSpec.cat, results: {} };
  for (const [name, u] of Object.entries(USERS)) {
    const r = await probe(u.id, probeSpec.p, u.org_id);
    const expected = probeSpec.exp[name];
    const actual = r.decision;
    const match = actual === expected;
    row.results[name] = { actual, expected, reason: r.reason, match };
    total++;
    if (!match) mismatches++;
  }
  results.push(row);
}

console.log(JSON.stringify({ total, mismatches, results }, null, 2));
process.exit(mismatches > 0 ? 1 : 0);
