/**
 * #178: bay-api route coverage against a real migrated database: authentication, the API-key
 * scope gate, org scoping on every read and write, and the main review flow (asset, version,
 * annotation, resolve, decision) including its realtime fanout. The public guest surface is
 * covered by review-link-token.db.test.ts.
 *
 * Runs whenever DATABASE_URL points at a migrated database; skips otherwise.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createWorld, destroyWorld, type World } from './helpers/world.js';
import type { TestApp } from './helpers/app.js';

const DATABASE_URL = process.env.DATABASE_URL;

vi.mock('../src/env.js', async () => ({ env: (await import('./helpers/app.js')).testEnv() }));

describe.skipIf(!DATABASE_URL)('bay-api routes (#178, real DB)', () => {
  let sql: postgres.Sql;
  let w: World;
  let t: TestApp;
  let app: FastifyInstance;

  const as = (session: string) => ({ cookie: `session=${session}` });
  const key = (k: string) => ({ authorization: `Bearer ${k}` });

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, { max: 2, onnotice: () => {} });
    w = await createWorld(sql);
    t = await (await import('./helpers/app.js')).buildBayApp();
    app = t.app;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (w) await destroyWorld(sql, w);
    await sql?.end({ timeout: 5 });
    const { connection } = await import('../src/db/index.js');
    await connection.end({ timeout: 5 });
  });

  async function newReview(session: string, name: string) {
    const asset = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: as(session),
      payload: { name, media_kind: 'image' },
    });
    expect(asset.statusCode, asset.body).toBe(201);
    const version = await app.inject({
      method: 'POST',
      url: `/v1/assets/${asset.json().data.id}/versions`,
      headers: as(session),
      payload: {},
    });
    expect(version.statusCode, version.body).toBe(201);
    return { assetId: asset.json().data.id as string, versionId: version.json().data.version.id as string };
  }

  describe('authentication', () => {
    it('every member route is 401 without a session or key', async () => {
      for (const [method, url] of [
        ['GET', '/v1/assets'],
        ['POST', '/v1/assets'],
        ['GET', `/v1/assets/${randomUUID()}`],
        ['GET', `/v1/versions/${randomUUID()}/annotations`],
        ['PUT', `/v1/versions/${randomUUID()}/decision`],
        ['GET', `/v1/review-links?asset_id=${randomUUID()}`],
      ] as const) {
        const res = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    });

    it('an expired session is not a session', async () => {
      await sql`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = ${w.sessions.gilligan}`;
      try {
        expect((await app.inject({ method: 'GET', url: '/v1/assets', headers: as(w.sessions.gilligan) })).statusCode).toBe(401);
      } finally {
        await sql`UPDATE sessions SET expires_at = now() + interval '1 hour' WHERE id = ${w.sessions.gilligan}`;
      }
    });

    it("a Bam API key authenticates, and a 'read' key may read but not write", async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/assets', headers: key(w.readKey) })).statusCode).toBe(200);
      const write = await app.inject({
        method: 'POST',
        url: '/v1/assets',
        headers: key(w.readKey),
        payload: { name: 'Daily Coconut Count', media_kind: 'image' },
      });
      expect(write.statusCode).toBe(403);
      expect(write.json().error.message).toMatch(/scope/);
    });

    it('an unknown key is 401', async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/assets', headers: key('bbam_notarealkey0000') })).statusCode).toBe(401);
    });
  });

  describe('the review flow', () => {
    it('asset, version, annotation, resolve and decision, each broadcast to the version channel', async () => {
      const { assetId, versionId } = await newReview(w.sessions.skipper, 'Howell Luau RSVP flyer');

      const versions = await app.inject({ method: 'GET', url: `/v1/assets/${assetId}/versions`, headers: as(w.sessions.skipper) });
      expect(versions.json().data.map((v: { id: string }) => v.id)).toEqual([versionId]);

      t.published.length = 0;
      const note = await app.inject({
        method: 'POST',
        url: `/v1/versions/${versionId}/annotations`,
        headers: as(w.sessions.skipper),
        payload: { body: 'Move the tiki torch left.', anchor: { type: 'point', x: 0.4, y: 0.6 } },
      });
      expect(note.statusCode, note.body).toBe(201);
      const resolved = await app.inject({
        method: 'POST',
        url: `/v1/annotations/${note.json().data.id}/resolve`,
        headers: as(w.sessions.skipper),
        payload: { resolved: true },
      });
      expect(resolved.statusCode, resolved.body).toBe(200);
      const decision = await app.inject({
        method: 'PUT',
        url: `/v1/versions/${versionId}/decision`,
        headers: as(w.sessions.skipper),
        payload: { decision: 'approved', comment: 'Ship it before the rescue boat.' },
      });
      expect(decision.statusCode, decision.body).toBe(200);

      const decisions = await app.inject({ method: 'GET', url: `/v1/versions/${versionId}/decisions`, headers: as(w.sessions.skipper) });
      expect(decisions.json().data).toEqual([expect.objectContaining({ decision: 'approved' })]);
      // Resolved notes drop out of the default list and come back with include_resolved.
      const open = await app.inject({ method: 'GET', url: `/v1/versions/${versionId}/annotations`, headers: as(w.sessions.skipper) });
      expect(open.json().data).toEqual([]);
      const notes = await app.inject({
        method: 'GET',
        url: `/v1/versions/${versionId}/annotations?include_resolved=true`,
        headers: as(w.sessions.skipper),
      });
      expect(notes.json().data).toEqual([expect.objectContaining({ body: 'Move the tiki torch left.', resolved: true })]);

      expect(t.published.map((p) => [p.channel, JSON.parse(p.message).type])).toEqual([
        [`bay:version:${versionId}`, 'bay.annotation.created'],
        [`bay:version:${versionId}`, 'bay.annotation.resolved'],
        [`bay:version:${versionId}`, 'bay.decision.set'],
      ]);
    });

    it('a second version becomes current and versions list newest first', async () => {
      const { assetId, versionId } = await newReview(w.sessions.skipper, 'Castaway Rescue Request');
      const v2 = await app.inject({ method: 'POST', url: `/v1/assets/${assetId}/versions`, headers: as(w.sessions.skipper), payload: {} });
      expect(v2.statusCode).toBe(201);
      expect(v2.json().data.version.version_number).toBe(2);
      expect(v2.json().data.asset.current_version_id).toBe(v2.json().data.version.id);
      const list = await app.inject({ method: 'GET', url: `/v1/assets/${assetId}/versions`, headers: as(w.sessions.skipper) });
      expect(list.json().data.map((v: { id: string }) => v.id)).toEqual([v2.json().data.version.id, versionId]);
    });

    it('archiving hides an asset from the default list', async () => {
      const { assetId } = await newReview(w.sessions.skipper, 'Old raft blueprint');
      const archived = await app.inject({ method: 'POST', url: `/v1/assets/${assetId}/archive`, headers: as(w.sessions.skipper) });
      expect(archived.statusCode).toBe(200);
      const list = await app.inject({ method: 'GET', url: '/v1/assets', headers: as(w.sessions.skipper) });
      expect(list.json().data.map((a: { id: string }) => a.id)).not.toContain(assetId);
      const all = await app.inject({ method: 'GET', url: '/v1/assets?include_archived=true', headers: as(w.sessions.skipper) });
      expect(all.json().data.map((a: { id: string }) => a.id)).toContain(assetId);
    });

    it('a version cannot point at a Bin asset outside the org', async () => {
      const { assetId } = await newReview(w.sessions.skipper, 'Radio parts list');
      const res = await app.inject({
        method: 'POST',
        url: `/v1/assets/${assetId}/versions`,
        headers: as(w.sessions.skipper),
        payload: { bin_asset_id: randomUUID() },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('org scoping: org B never sees or touches org A reviews', () => {
    let a: { assetId: string; versionId: string };

    beforeAll(async () => {
      a = await newReview(w.sessions.skipper, 'Skipper private storm log');
    });

    it('reads', async () => {
      const howell = as(w.sessions.howell);
      const list = await app.inject({ method: 'GET', url: '/v1/assets', headers: howell });
      expect(list.statusCode).toBe(200);
      expect(list.json().data.map((x: { id: string }) => x.id)).not.toContain(a.assetId);
      for (const url of [
        `/v1/assets/${a.assetId}`,
        `/v1/assets/${a.assetId}/versions`,
        `/v1/versions/${a.versionId}`,
        `/v1/versions/${a.versionId}/annotations`,
        `/v1/versions/${a.versionId}/decisions`,
      ]) {
        expect((await app.inject({ method: 'GET', url, headers: howell })).statusCode, url).toBe(404);
      }
      const links = await app.inject({ method: 'GET', url: `/v1/review-links?asset_id=${a.assetId}`, headers: howell });
      expect(links.json().data).toEqual([]);
    });

    it('writes', async () => {
      const howell = as(w.sessions.howell);
      const attempts = [
        { method: 'POST', url: `/v1/assets/${a.assetId}/versions`, payload: {} },
        { method: 'POST', url: `/v1/assets/${a.assetId}/archive`, payload: undefined },
        { method: 'POST', url: `/v1/versions/${a.versionId}/annotations`, payload: { body: 'Mine now.' } },
        { method: 'PUT', url: `/v1/versions/${a.versionId}/decision`, payload: { decision: 'rejected' } },
        { method: 'POST', url: '/v1/review-links', payload: { asset_id: a.assetId } },
      ] as const;
      for (const x of attempts) {
        const res = await app.inject({ method: x.method, url: x.url, headers: howell, payload: x.payload });
        expect(res.statusCode, `${x.method} ${x.url}: ${res.body}`).toBe(404);
      }
      const [row] = await sql`SELECT archived_at, current_version_id FROM bay_assets WHERE id = ${a.assetId}`;
      expect(row!.archived_at).toBeNull();
      expect(row!.current_version_id).toBe(a.versionId);
      const [n] = await sql`SELECT count(*)::int AS n FROM bay_annotations WHERE version_id = ${a.versionId}`;
      expect(n!.n).toBe(0);
    });

    it("org B cannot resolve an org A annotation or revoke an org A share link", async () => {
      const note = await app.inject({
        method: 'POST',
        url: `/v1/versions/${a.versionId}/annotations`,
        headers: as(w.sessions.skipper),
        payload: { body: 'Storm at 0300.' },
      });
      const link = await app.inject({
        method: 'POST',
        url: '/v1/review-links',
        headers: as(w.sessions.skipper),
        payload: { asset_id: a.assetId },
      });
      const howell = as(w.sessions.howell);
      expect(
        (await app.inject({ method: 'POST', url: `/v1/annotations/${note.json().data.id}/resolve`, headers: howell, payload: {} })).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'DELETE', url: `/v1/review-links/${link.json().data.id}`, headers: howell })).statusCode,
      ).toBe(404);
      const [row] = await sql`SELECT revoked_at FROM bay_review_links WHERE id = ${link.json().data.id}`;
      expect(row!.revoked_at).toBeNull();
    });

    it('a user cannot pick another org with X-Org-Id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/assets',
        headers: { ...as(w.sessions.howell), 'x-org-id': w.orgA },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
