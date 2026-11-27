import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { bastionExportDismissResponseSchema, bastionExportListQuerySchema, bastionExportListResponseSchema } from '@bigbluebam/shared';
import { clock, DATABASE_URL, makeDeps, seedOrg, wipeOrg, type SeededOrg } from './engine-harness.js';
import { expectWire } from './wire.js';

/**
 * Review batch 42, #402 (live database). The Sharing page listed every audit packet, failed ones
 * included, with no way to clear them. A failed packet can now be dismissed: hidden from the
 * default list, audited, never deleted; a built packet (or one still being built) is refused, and
 * the database refuses a dismissal on a built packet even if a writer skipped the service check.
 * The auditor room list keeps its include_closed filter, which the page now sends.
 */

if (!DATABASE_URL) console.warn('[bastion-api/b42-sharing-dismiss] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

describe.skipIf(!DATABASE_URL)('batch 42: dismissing failed audit packets (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];
  let sharing: typeof import('../../src/services/sharing.service.js');

  beforeAll(async () => {
    const hex = 'a'.repeat(64);
    Object.assign(process.env, {
      SESSION_SECRET: process.env.SESSION_SECRET ?? 's'.repeat(40),
      INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET ?? 'i'.repeat(40),
      BASTION_SEAL_SIGNING_KEY: process.env.BASTION_SEAL_SIGNING_KEY ?? hex,
      BASTION_PD_HMAC_KEY: process.env.BASTION_PD_HMAC_KEY ?? hex,
      BASTION_ROOM_IP_SALT: process.env.BASTION_ROOM_IP_SALT ?? hex,
      BASTION_FEED_KEY_PEPPER: process.env.BASTION_FEED_KEY_PEPPER ?? hex,
    });
    sql = postgres(String(DATABASE_URL), { max: 4, onnotice: () => {} });
    sharing = await import('../../src/services/sharing.service.js');
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
  });

  const viewerOf = (s: SeededOrg) => ({ id: s.owner, org_id: s.org, role: 'owner', is_superuser: false, impersonator_id: null, auth_method: 'session' as const });

  async function packetRow(s: SeededOrg, status: 'failed' | 'succeeded' | 'running', error: string | null = null) {
    const [p] = await sql`INSERT INTO bastion_export_packets (organization_id, framework_id, period_start, period_end, status, error, requested_by)
                          VALUES (${s.org}, ${s.framework}, '2026-01-01', '2026-06-30', ${status}, ${error}, ${s.owner}) RETURNING id`;
    return String(p?.id);
  }

  it('a failed packet is dismissed (hidden, audited, kept); a built or running one is refused; the database backs the rule', async () => {
    const s = await seedOrg(sql, 'b42-dismiss', 0, 0);
    orgs.push(s.org);
    const d = { engine: makeDeps(sql, { clock: clock() }), enqueuePacket: async () => true };
    const v = viewerOf(s);
    const failed = await packetRow(s, 'failed', 'nodestream is not supported by this platform');
    const built = await packetRow(s, 'succeeded');
    const running = await packetRow(s, 'running');
    const ids = async (q: Record<string, string> = {}) =>
      (await sharing.listExports(d, v, bastionExportListQuerySchema.parse(q))).data.map((p) => p.id).sort();

    expect(await ids()).toEqual([failed, built, running].sort());

    const out = await sharing.dismissExport(d, v, failed);
    expectWire(bastionExportDismissResponseSchema, out);
    expect(out.data).toMatchObject({ id: failed, status: 'failed' });
    expect(out.data.dismissed_at).not.toBeNull();

    // Hidden by default; still listed on request; the row is kept with who and when.
    expect(await ids()).toEqual([built, running].sort());
    const all = await sharing.listExports(d, v, bastionExportListQuerySchema.parse({ include_dismissed: 'true' }));
    expectWire(bastionExportListResponseSchema, all);
    expect(all.data.map((p) => p.id).sort()).toEqual([failed, built, running].sort());
    const [kept] = await sql`SELECT status, dismissed_by FROM bastion_export_packets WHERE id = ${failed}`;
    expect(kept).toMatchObject({ status: 'failed', dismissed_by: s.owner });
    const audits = await sql`SELECT action FROM bastion_audit_log WHERE organization_id = ${s.org} AND action = 'export.dismiss' AND subject_id = ${failed}`;
    expect(audits).toHaveLength(1);

    // Dismissing again is a no-op: same row, no second audit row.
    await sharing.dismissExport(d, v, failed);
    expect(await sql`SELECT 1 FROM bastion_audit_log WHERE organization_id = ${s.org} AND action = 'export.dismiss'`).toHaveLength(1);

    // A built packet, or one still being built, cannot be dismissed.
    await expect(sharing.dismissExport(d, v, built)).rejects.toMatchObject({ code: 'PACKET_NOT_FAILED' });
    await expect(sharing.dismissExport(d, v, running)).rejects.toMatchObject({ code: 'PACKET_NOT_FAILED' });
    expect(await ids()).toEqual([built, running].sort());

    // Another org's packet is not found.
    const other = await seedOrg(sql, 'b42-dismiss-other', 0, 0);
    orgs.push(other.org);
    await expect(sharing.dismissExport(d, viewerOf(other), failed)).rejects.toMatchObject({ name: 'NotFoundError' });

    // The CHECK in migration 0364 refuses a dismissal on a built packet whatever the writer.
    await expect(sql`UPDATE bastion_export_packets SET dismissed_at = now() WHERE id = ${built}`).rejects.toMatchObject({
      constraint_name: 'bastion_export_packets_dismiss_not_built',
    });
  });
});
