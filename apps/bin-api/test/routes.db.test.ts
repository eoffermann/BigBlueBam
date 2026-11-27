/**
 * #178: bin-api route coverage against a real migrated database: authentication, the API-key
 * scope gate, org scoping on every read and write, and the storage paths (proxied upload into
 * an org-namespaced object key, the AV-scan serving gate, byte ranges, and delete removing the
 * bytes). Storage is an in-memory driver; everything else is the real service and SQL.
 *
 * Runs whenever DATABASE_URL points at a migrated database; skips otherwise.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createWorld, destroyWorld, type World } from './helpers/world.js';

const DATABASE_URL = process.env.DATABASE_URL;

const mem = vi.hoisted(() => ({ store: null as null | ReturnType<typeof import('./helpers/app.js').memoryDriver> }));

vi.mock('../src/env.js', async () => ({ env: (await import('./helpers/app.js')).testEnv() }));
vi.mock('../src/lib/storage.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/storage.js')>();
  const { memoryDriver } = await import('./helpers/app.js');
  mem.store = memoryDriver();
  return { ...real, getMediaDriver: () => mem.store!.driver };
});

describe.skipIf(!DATABASE_URL)('bin-api routes (#178, real DB)', () => {
  let sql: postgres.Sql;
  let w: World;
  let app: FastifyInstance;
  let multipartFile: typeof import('./helpers/app.js').multipartFile;

  const as = (session: string) => ({ cookie: `session=${session}` });
  const key = (k: string) => ({ authorization: `Bearer ${k}` });
  const BYTES = Buffer.from('Daily Coconut Count: 1,204 coconuts, 3 suspicious.');

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, { max: 2, onnotice: () => {} });
    w = await createWorld(sql);
    const helpers = await import('./helpers/app.js');
    multipartFile = helpers.multipartFile;
    app = await helpers.buildBinApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (w) await destroyWorld(sql, w);
    await sql?.end({ timeout: 5 });
    const { connection } = await import('../src/db/index.js');
    await connection.end({ timeout: 5 });
  });

  async function newAsset(session: string, name: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: as(session),
      payload: { name, content_type: 'text/plain', tags: ['island'] },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data.id as string;
  }

  async function upload(session: string, assetId: string, body = BYTES) {
    const mp = multipartFile('coconuts.txt', 'text/plain', body);
    return app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/upload`,
      headers: { ...as(session), ...mp.headers },
      payload: mp.payload,
    });
  }

  const raw = (session: string, assetId: string, extra: Record<string, string> = {}, qs = '') =>
    app.inject({ method: 'GET', url: `/v1/assets/${assetId}/raw${qs}`, headers: { ...as(session), ...extra } });

  describe('authentication', () => {
    it('every route is 401 without a session or key', async () => {
      for (const [method, url] of [
        ['GET', '/v1/assets'],
        ['POST', '/v1/assets'],
        ['GET', `/v1/assets/${randomUUID()}/raw`],
        ['POST', `/v1/assets/${randomUUID()}/upload`],
        ['GET', '/v1/folders'],
        ['GET', '/v1/scan/overview'],
      ] as const) {
        const res = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    });

    it("a Bam API key authenticates, and a 'read' key may read but not write", async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/assets', headers: key(w.readKey) })).statusCode).toBe(200);
      const write = await app.inject({
        method: 'POST',
        url: '/v1/assets',
        headers: key(w.readKey),
        payload: { name: 'Radio schematic', content_type: 'image/png' },
      });
      expect(write.statusCode).toBe(403);
    });
  });

  describe('storage paths', () => {
    it('a proxied upload lands under an org-namespaced key and becomes the current version', async () => {
      const id = await newAsset(w.sessions.skipper, 'Daily Coconut Count');
      const res = await upload(w.sessions.skipper, id);
      expect(res.statusCode, res.body).toBe(201);
      const { version, asset } = res.json().data;
      expect(version.version_number).toBe(1);
      expect(asset.current_version_id).toBe(version.id);
      expect(asset.size).toBe(BYTES.length);
      expect(asset.scan_status).toBe('pending');
      expect(version.object_key).toContain(w.orgA);
      expect(mem.store!.objects.get(version.object_key)?.body.equals(BYTES)).toBe(true);
    });

    it('the AV-scan gate: pending bytes are refused, an admin may inspect with acknowledge_risk, clean bytes serve', async () => {
      const id = await newAsset(w.sessions.skipper, 'Rescue Sighting Report');
      expect((await upload(w.sessions.skipper, id)).statusCode).toBe(201);

      expect((await raw(w.sessions.gilligan, id)).statusCode).toBe(409);
      expect((await raw(w.sessions.gilligan, id, {}, '?acknowledge_risk=true')).statusCode).toBe(409);
      const admin = await raw(w.sessions.skipper, id, {}, '?acknowledge_risk=true');
      expect(admin.statusCode, admin.body).toBe(200);
      expect(admin.body).toBe(BYTES.toString());

      await sql`UPDATE bin_assets SET scan_status = 'clean' WHERE id = ${id}`;
      const clean = await raw(w.sessions.gilligan, id);
      expect(clean.statusCode).toBe(200);
      expect(clean.headers['content-type']).toMatch(/text\/plain/);

      const ranged = await raw(w.sessions.gilligan, id, { range: 'bytes=6-13' });
      expect(ranged.statusCode).toBe(206);
      expect(ranged.body).toBe('Coconut ');
      expect(ranged.headers['content-range']).toBe(`bytes 6-13/${BYTES.length}`);
    });

    it('an infected file is refused even to an admin unless overridden; only an admin may override', async () => {
      const id = await newAsset(w.sessions.skipper, 'Suspicious coconut.exe');
      expect((await upload(w.sessions.skipper, id)).statusCode).toBe(201);
      await sql`UPDATE bin_assets SET scan_status = 'infected' WHERE id = ${id}`;
      expect((await raw(w.sessions.skipper, id)).statusCode).toBe(409);

      const override = (session: string) =>
        app.inject({
          method: 'POST',
          url: `/v1/assets/${id}/scan-override`,
          headers: as(session),
          payload: { allow: true, reason: 'Professor confirmed it is a coconut.' },
        });
      expect((await override(w.sessions.gilligan)).statusCode).toBe(403);
      const ok = await override(w.sessions.skipper);
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await raw(w.sessions.gilligan, id)).statusCode).toBe(200);
    });

    it('delete removes the row and the bytes', async () => {
      const id = await newAsset(w.sessions.skipper, 'Old raft plan');
      const up = await upload(w.sessions.skipper, id);
      const objectKey: string = up.json().data.version.object_key;
      const del = await app.inject({ method: 'DELETE', url: `/v1/assets/${id}`, headers: as(w.sessions.skipper) });
      expect(del.statusCode, del.body).toBe(200);
      expect(mem.store!.objects.has(objectKey)).toBe(false);
      expect(await sql`SELECT id FROM bin_assets WHERE id = ${id}`).toHaveLength(0);
    });

    it('tags and folders round-trip', async () => {
      const folder = await app.inject({
        method: 'POST',
        url: '/v1/folders',
        headers: as(w.sessions.skipper),
        payload: { name: 'Lagoon photos' },
      });
      expect(folder.statusCode, folder.body).toBe(201);
      const id = await newAsset(w.sessions.skipper, 'Lagoon at dawn');
      const moved = await app.inject({
        method: 'PATCH',
        url: `/v1/assets/${id}`,
        headers: as(w.sessions.skipper),
        payload: { folder_id: folder.json().data.id, tags: ['lagoon'] },
      });
      expect(moved.statusCode, moved.body).toBe(200);
      const inFolder = await app.inject({
        method: 'GET',
        url: `/v1/assets?folder_id=${folder.json().data.id}`,
        headers: as(w.sessions.skipper),
      });
      expect(inFolder.json().data.map((a: { id: string }) => a.id)).toEqual([id]);
      const tags = await app.inject({ method: 'GET', url: '/v1/tags', headers: as(w.sessions.skipper) });
      expect(tags.json().data).toEqual(expect.arrayContaining(['island', 'lagoon']));
    });
  });

  describe('org scoping: org B never sees or touches org A files', () => {
    let assetId: string;
    let objectKey: string;
    let folderId: string;

    beforeAll(async () => {
      assetId = await newAsset(w.sessions.skipper, 'Skipper private log');
      objectKey = (await upload(w.sessions.skipper, assetId)).json().data.version.object_key;
      await sql`UPDATE bin_assets SET scan_status = 'clean' WHERE id = ${assetId}`;
      folderId = (
        await app.inject({ method: 'POST', url: '/v1/folders', headers: as(w.sessions.skipper), payload: { name: 'Minnow logs' } })
      ).json().data.id;
    });

    it('reads', async () => {
      const howell = as(w.sessions.howell);
      const list = await app.inject({ method: 'GET', url: '/v1/assets', headers: howell });
      expect(list.json().data.map((a: { id: string }) => a.id)).not.toContain(assetId);
      for (const url of [
        `/v1/assets/${assetId}`,
        `/v1/assets/${assetId}/raw`,
        `/v1/assets/${assetId}/versions`,
        `/v1/folders/${folderId}`,
      ]) {
        expect((await app.inject({ method: 'GET', url, headers: howell })).statusCode, url).toBe(404);
      }
      const folders = await app.inject({ method: 'GET', url: '/v1/folders', headers: howell });
      expect(folders.json().data.map((f: { id: string }) => f.id)).not.toContain(folderId);
    });

    it('writes', async () => {
      const howell = as(w.sessions.howell);
      expect((await upload(w.sessions.howell, assetId, Buffer.from('overwritten'))).statusCode).toBe(404);
      for (const x of [
        { method: 'PATCH', url: `/v1/assets/${assetId}`, payload: { name: 'Mine now' } },
        { method: 'POST', url: `/v1/assets/${assetId}/archive`, payload: undefined },
        { method: 'DELETE', url: `/v1/assets/${assetId}`, payload: undefined },
        { method: 'PATCH', url: `/v1/folders/${folderId}`, payload: { name: 'Mine now' } },
        { method: 'DELETE', url: `/v1/folders/${folderId}`, payload: undefined },
      ] as const) {
        const res = await app.inject({ method: x.method, url: x.url, headers: howell, payload: x.payload });
        expect(res.statusCode, `${x.method} ${x.url}: ${res.body}`).toBe(404);
      }
      const bulk = await app.inject({
        method: 'POST',
        url: '/v1/assets/bulk-delete',
        headers: howell,
        payload: { ids: [assetId] },
      });
      expect(bulk.statusCode).toBe(200);

      const [row] = await sql`SELECT name, archived_at FROM bin_assets WHERE id = ${assetId}`;
      expect(row).toMatchObject({ name: 'Skipper private log', archived_at: null });
      expect(mem.store!.objects.get(objectKey)?.body.equals(BYTES)).toBe(true);
      expect(await sql`SELECT id FROM bin_folders WHERE id = ${folderId}`).toHaveLength(1);
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
