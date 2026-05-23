// One-shot diagnostic: probe the resolver via /internal/permissions/dual-read
// for a fixed user_id across a few permission ids. Confirms that mode=on
// enforcement is fed by a working resolver pipeline.
//
// Usage: node scripts/probe-resolver.mjs <user_id>

const userId = process.argv[2];
if (!userId) {
  console.error('usage: node scripts/probe-resolver.mjs <user_id>');
  process.exit(2);
}
const secret = process.env.INTERNAL_SERVICE_SECRET;
if (!secret) {
  console.error('INTERNAL_SERVICE_SECRET must be set in env');
  process.exit(2);
}
const apiUrl = process.env.BBB_API_INTERNAL_URL ?? 'http://localhost:4000';

const perms = [
  'bam.auth_api_key.list',
  'bam.task.create',
  'bam.task.delete',
  'bam.platform_org.list',
  'bam.platform_org.create',
  'bam.entity_link.delete',
  'bam.user.list',
  'bam.system_setting.update',
];

for (const p of perms) {
  try {
    const r = await fetch(`${apiUrl}/internal/permissions/dual-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({
        user_id: userId,
        permission_id: p,
        agent_policy_decision: 'allow',
        scope: { org_id: null, project_id: null },
      }),
    });
    const j = await r.json();
    const d = j.data;
    console.log(`${p.padEnd(34)} ${d?.decision ?? '?'}  ${d?.reason ?? ''}`);
  } catch (e) {
    console.log(`${p.padEnd(34)} error: ${e.message}`);
  }
}
