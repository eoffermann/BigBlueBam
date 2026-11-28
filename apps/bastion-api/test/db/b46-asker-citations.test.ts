import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  bastionEvidenceSnapshotListResponseSchema,
  bastionEvidenceSnapshotResponseSchema,
  bastionExceptionListResponseSchema,
  bastionExceptionResponseSchema,
  bastionFixDraftListResponseSchema,
} from '@bigbluebam/shared';
import type { DecisionDeps } from '../../src/services/decisions.service.js';
import type { Viewer } from '../../src/services/types.js';
import { DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';
import { expectWire } from './wire.js';

/**
 * Review batch 46, #414 (live database). The evidence, fix-draft and exception reads return cited
 * source records. With asker_user_id (an agent reading for a person) each one must pass can_access
 * for the asker as well as the caller, and evidence detail needs both to qualify. Before the fix
 * the services ignored the asker: the Skipper's agent answering the Professor relayed the Howells'
 * API key, and exceptions returned their cited item and frozen refs to anyone, unfiltered.
 */

if (!DATABASE_URL) console.warn('[bastion-api/b46-asker-citations] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

const SHA = 'a'.repeat(64);
const DAY = 86_400_000;
const RADIO_KEY = '0b5e0000-0000-4000-8000-0000000b4601';
const HOWELL_KEY = '0b5e0000-0000-4000-8000-0000000b4602';

describe.skipIf(!DATABASE_URL)('batch 46: citation reads narrow for asker_user_id (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];
  let evidence: typeof import('../../src/services/evidence.service.js');
  let fixes: typeof import('../../src/services/fixes.service.js');
  let exceptions: typeof import('../../src/services/exceptions.service.js');

  beforeAll(async () => {
    // env.ts validates at import (evidence.service reaches it through lib/keys).
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
    evidence = await import('../../src/services/evidence.service.js');
    fixes = await import('../../src/services/fixes.service.js');
    exceptions = await import('../../src/services/exceptions.service.js');
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) {
      await sql`DELETE FROM account_group_memberships WHERE scope_type = 'org' AND scope_id = ${org}`;
      await wipeOrg(sql, org);
    }
    await sql.end();
    const db = await import('../../src/db/index.js');
    for (const c of db.allConnections()) await c.end();
  });

  async function member(org: string, tag: string, role: 'admin' | 'member') {
    const [u] = await sql`INSERT INTO users (org_id, email, display_name, password_hash, kind)
                          VALUES (${org}, ${`b46-${tag}-${Date.now()}@bigbluebam.internal`}, ${tag}, '!', 'human') RETURNING id`;
    const id = u!.id as string;
    await sql`INSERT INTO organization_memberships (user_id, org_id) VALUES (${id}, ${org})`;
    if (role === 'admin') {
      // The org role is membership in the built-in global Admin group scoped to this org
      // (legacy_role 'admin'), as anOrgAdmin and userIsOrgAdmin read it.
      const [g] = await sql`SELECT id FROM permission_groups WHERE is_builtin AND legacy_role = 'admin' AND deleted_at IS NULL LIMIT 1`;
      await sql`INSERT INTO account_group_memberships (user_id, group_id, scope_type, scope_id) VALUES (${id}, ${g!.id as string}, 'org', ${org})`;
    }
    return id;
  }

  it('evidence, fix drafts and exceptions show the asker only what both may open', async () => {
    const s = await seedOrg(sql, 'b46-asker', 1, 1);
    orgs.push(s.org);
    const professor = await member(s.org, 'professor', 'admin');
    const gilligan = await member(s.org, 'gilligan', 'member');
    const deps = makeDeps(sql);
    // The Skipper may open everything; nobody else may open the Howells' key.
    const canAccess = async (user: string, _type: string, id: string) => user === s.owner || id !== HOWELL_KEY;
    const d: DecisionDeps = { engine: deps, canAccess };
    const skipper: Viewer = { id: s.owner, org_id: s.org, role: 'owner', is_superuser: false, impersonator_id: null, auth_method: 'api_key' };
    const forProfessor: Viewer = { ...skipper, asker_id: professor };
    const forGilligan: Viewer = { ...skipper, asker_id: gilligan };
    const [control, assertion] = [s.controls[0]!, s.assertions[0]!];
    const refs = [
      { entity_type: 'api_key', entity_id: RADIO_KEY },
      { entity_type: 'api_key', entity_id: HOWELL_KEY },
    ];
    // key_prefix is varchar(12).
    const prefix = `b46${Date.now() % 1_000_000}`;
    await sql`INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, org_id) VALUES
                (${RADIO_KEY}, ${s.owner}, 'Radio Relay', 'x', ${`${prefix}r`}, ${s.org}),
                (${HOWELL_KEY}, ${s.owner}, 'Howell Estate', 'x', ${`${prefix}h`}, ${s.org})`;

    // ── Evidence (rows 25, 26) ──
    const [run] = await sql`INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, control_id, as_of, status)
                            VALUES (${s.org}, 'manual', 'control', ${control}, now(), 'succeeded') RETURNING id`;
    const [snap] = await sql`INSERT INTO bastion_evidence_snapshots (organization_id, evaluation_run_id, assertion_id, control_id, outcome, cited_refs, content_sha256)
                             VALUES (${s.org}, ${run!.id as string}, ${assertion}, ${control}, 'fail', ${sql.json(refs as never)}, ${SHA}) RETURNING id`;
    const ids = (rows: Array<{ entity_id: string }>) => rows.map((r) => r.entity_id);

    const own = (await evidence.listControlEvidence(deps, skipper, control, { limit: 50 }, canAccess)).data[0]!;
    expect(ids(own.cited_refs)).toEqual([RADIO_KEY, HOWELL_KEY]);
    expect(own.hidden_citation_count).toBe(0);
    expect(own.cited_labels).toEqual(['API key "Radio Relay"', 'API key "Howell Estate"']);

    const listed = await evidence.listControlEvidence(deps, forProfessor, control, { limit: 50 }, canAccess);
    expectWire(bastionEvidenceSnapshotListResponseSchema, listed);
    const p = listed.data[0]!;
    expect(p.detail_visible).toBe(true);
    expect(ids(p.cited_refs)).toEqual([RADIO_KEY]);
    expect(ids(p.cited_items)).toEqual([RADIO_KEY]);
    expect(p.cited_labels).toEqual(['API key "Radio Relay"']);
    expect(p.hidden_citation_count).toBe(1);

    const one = await evidence.getEvidence(deps, forProfessor, snap!.id as string, canAccess);
    expectWire(bastionEvidenceSnapshotResponseSchema, one);
    expect(ids(one.data.cited_refs)).toEqual([RADIO_KEY]);
    expect(one.data.hidden_citation_count).toBe(1);

    // A member who does not own the control gets the counts-only view, as they would themselves.
    const g = (await evidence.getEvidence(deps, forGilligan, snap!.id as string, canAccess)).data;
    expect(g.detail_visible).toBe(false);
    expect(g.cited_refs).toEqual([]);
    expect(g.cited_items).toEqual([]);

    // ── Fix drafts (rows 54, 55) ──
    const [draft] = await sql`INSERT INTO bastion_fix_drafts (organization_id, template, title, cited_refs, status, created_by, created_by_kind)
                              VALUES (${s.org}, 'config_change', 'Rotate the keys', ${sql.json(refs as never)}, 'proposed', ${s.owner}, 'human') RETURNING id`;
    const ownDraft = (await fixes.getFixDraft(d, skipper, draft!.id as string)).data;
    expect(ids(ownDraft.cited_refs)).toEqual([RADIO_KEY, HOWELL_KEY]);
    const drafts = await fixes.listFixDrafts(d, forProfessor, { limit: 50 });
    expectWire(bastionFixDraftListResponseSchema, drafts);
    const pd = drafts.data.find((x) => x.id === draft!.id)!;
    expect(ids(pd.cited_refs)).toEqual([RADIO_KEY]);
    expect(pd.hidden_citation_count).toBe(1);
    expect(ids((await fixes.getFixDraft(d, forProfessor, draft!.id as string)).data.cited_refs)).toEqual([RADIO_KEY]);

    // ── Exceptions (rows 58, 59): previously never filtered at all ──
    const until = new Date(Date.now() + 30 * DAY);
    const [entityEx] = await sql`INSERT INTO bastion_exceptions (organization_id, control_id, scope, cited_entity_type, cited_entity_id, reason, status, proposed_by, expires_at)
                                 VALUES (${s.org}, ${control}, 'entity', 'api_key', ${HOWELL_KEY}, 'Rotated by hand', 'proposed', ${s.owner}, ${until}) RETURNING id`;
    const [wideEx] = await sql`INSERT INTO bastion_exceptions (organization_id, control_id, assertion_id, scope, frozen_refs, reason, status, proposed_by, expires_at)
                               VALUES (${s.org}, ${control}, ${assertion}, 'assertion', ${sql.json(refs as never)}, 'Island hut', 'proposed', ${s.owner}, ${until}) RETURNING id`;
    const byId = (list: { data: Array<{ id: string }> }, id: unknown) => list.data.find((x) => x.id === id) as Record<string, unknown>;

    const ownList = await exceptions.listExceptions(deps, skipper, { limit: 50 }, canAccess);
    expect(byId(ownList, entityEx!.id)).toMatchObject({ cited_entity_id: HOWELL_KEY, hidden_citation_count: 0 });
    expect(ids(byId(ownList, wideEx!.id).frozen_refs as Array<{ entity_id: string }>)).toEqual([RADIO_KEY, HOWELL_KEY]);

    const asked = await exceptions.listExceptions(deps, forProfessor, { limit: 50 }, canAccess);
    expectWire(bastionExceptionListResponseSchema, JSON.parse(JSON.stringify(asked)));
    expect(byId(asked, entityEx!.id)).toMatchObject({ cited_entity_type: null, cited_entity_id: null, hidden_citation_count: 1 });
    expect(byId(asked, wideEx!.id)).toMatchObject({ hidden_citation_count: 1 });
    expect(ids(byId(asked, wideEx!.id).frozen_refs as Array<{ entity_id: string }>)).toEqual([RADIO_KEY]);

    const oneEx = await exceptions.getException(deps, forProfessor, entityEx!.id as string, canAccess);
    expectWire(bastionExceptionResponseSchema, JSON.parse(JSON.stringify(oneEx)));
    expect(oneEx.data.cited_entity_id).toBeNull();
    // Without an asker a reader is still filtered for themselves (spec 2.4).
    const plainProfessor: Viewer = { ...skipper, id: professor };
    expect((await exceptions.getException(deps, plainProfessor, entityEx!.id as string, canAccess)).data.cited_entity_id).toBeNull();
  });
});
