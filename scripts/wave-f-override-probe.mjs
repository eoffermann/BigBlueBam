#!/usr/bin/env node
// Wave F audit — verify override behavior on a denied permission.

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const SECRET = execSync('docker compose exec -T api printenv INTERNAL_SERVICE_SECRET', { encoding: 'utf8' }).trim();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let REDIS_PASSWORD = '';
try { REDIS_PASSWORD = execSync('docker compose exec -T redis printenv REDIS_PASSWORD', { encoding: 'utf8' }).trim(); } catch {}
if (!REDIS_PASSWORD) {
  try { REDIS_PASSWORD = execSync('grep "^REDIS_PASSWORD=" .env', { encoding: 'utf8' }).trim().split('=', 2)[1] || ''; } catch {}
}

const AVERY = '969d36a7-a10d-4a64-99dc-f2a95fe2b038';
const EDDIE = '65429e63-65c7-4f74-a19e-977217128edc';
const ORG = '57158e52-227d-4903-b0d8-d9f3c4910f61';
const PERMISSION = 'bam.audit_log.list';

async function probe() {
  const resp = await fetch('https://localhost/b3/api/internal/permissions/dual-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': SECRET },
    body: JSON.stringify({ user_id: AVERY, permission_id: PERMISSION, scope: { org_id: ORG, project_id: null } }),
  });
  return (await resp.json()).data;
}

function psqlFile(sql) {
  writeFileSync('./wave-f-probe.sql', sql);
  execSync('docker cp ./wave-f-probe.sql bigbluebam-postgres-1:./wave-f-probe.sql');
  return execSync(`docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -f ./wave-f-probe.sql`, { encoding: 'utf8' });
}

function publishInval(channel) {
  if (!REDIS_PASSWORD) return '';
  return execSync(`docker compose exec -T redis redis-cli -a "${REDIS_PASSWORD}" --no-auth-warning PUBLISH ${channel} reason=audit 2>&1 || true`, { encoding: 'utf8' });
}

console.log('=== Step 1: Probe avery before override ===');
const before = await probe();
console.log(JSON.stringify(before));

console.log('\n=== Step 2: Insert override ===');
const ins = psqlFile(`
INSERT INTO account_permissions (user_id, scope_type, scope_id, permission_id, granted, is_snapshot, set_by, notes)
VALUES ('${AVERY}', 'org', '${ORG}', '${PERMISSION}', true, false, '${EDDIE}', 'wave-f audit probe')
ON CONFLICT (user_id, scope_type, scope_id, permission_id) DO UPDATE SET granted = true, is_snapshot = false, notes = 'wave-f audit probe';
SELECT permission_id, granted, is_snapshot FROM account_permissions
WHERE user_id = '${AVERY}' AND scope_type = 'org' AND scope_id = '${ORG}' AND permission_id = '${PERMISSION}';
`);
console.log(ins);

console.log('cache invalidate:', publishInval(`perms:invalidate:user:${AVERY}`));

console.log('\n=== Step 3: Probe avery after override ===');
const after = await probe();
console.log(JSON.stringify(after));

console.log('\n=== Step 4: Cleanup (drop overrides + reattach) ===');
const del = psqlFile(`
DELETE FROM account_permissions WHERE user_id = '${AVERY}' AND scope_type = 'org' AND scope_id = '${ORG}';
UPDATE account_group_memberships SET detached_at = NULL, detached_by = NULL WHERE user_id = '${AVERY}';
SELECT 'overrides_remaining', count(*) FROM account_permissions WHERE user_id = '${AVERY}';
SELECT 'detached_at', detached_at FROM account_group_memberships WHERE user_id = '${AVERY}';
`);
console.log(del);
publishInval(`perms:invalidate:user:${AVERY}`);

console.log('\n=== Step 5: Probe avery after cleanup ===');
const cleanedUp = await probe();
console.log(JSON.stringify(cleanedUp));

const before_ok = before.decision === 'deny';
const after_ok = after.decision === 'allow' && /override/i.test(after.reason || '');
const cleaned_ok = cleanedUp.decision === 'deny';

console.log(`\n=== Summary ===`);
console.log(`before deny: ${before_ok ? 'PASS' : 'FAIL'} (got ${before.decision} / ${before.reason})`);
console.log(`after allow via override: ${after_ok ? 'PASS' : 'FAIL'} (got ${after.decision} / ${after.reason})`);
console.log(`cleanup back to deny: ${cleaned_ok ? 'PASS' : 'FAIL'} (got ${cleanedUp.decision} / ${cleanedUp.reason})`);

process.exit(before_ok && after_ok && cleaned_ok ? 0 : 1);
