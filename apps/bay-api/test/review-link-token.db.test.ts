/**
 * #122: Bay guest review link tokens, against a real migrated database.
 *
 * The token used to be stored in plaintext (bay_review_links.token) and sent in the URL path
 * (/bay/r/<token>, /v1/public/review/<token>), so a database read, a backup, a query log, an
 * access log or a Referer header opened every live guest review. Now only its SHA-256 is stored,
 * the share URL carries the token in the fragment, the JSON API takes it in a header, and media
 * is streamed against a short-lived ticket.
 *
 * Runs whenever DATABASE_URL points at a migrated database (the Test workflow's Postgres
 * service, or a throwaway container); skips otherwise.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { createWorld, destroyWorld, type World } from './helpers/world.js';

const DATABASE_URL = process.env.DATABASE_URL;

vi.mock('../src/env.js', async () => ({ env: (await import('./helpers/app.js')).testEnv() }));
vi.mock('../src/lib/bin-media.js', () => ({
  hasRangeSupport: () => false,
  statBinMedia: async () => null,
  rangeBinMedia: async () => null,
  streamBinMedia: async () => ({ contentType: 'video/mp4', size: 7, stream: Readable.from([Buffer.from('coconut')]) }),
}));

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe.skipIf(!DATABASE_URL)('Bay guest review link tokens (#122, real DB)', () => {
  let sql: postgres.Sql;
  let w: World;
  let app: FastifyInstance;
  let assetId: string;

  const as = (session: string) => ({ cookie: `session=${session}` });

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, { max: 2, onnotice: () => {} });
    w = await createWorld(sql);
    ({ app } = await (await import('./helpers/app.js')).buildBayApp());

    const asset = await app.inject({
      method: 'POST',
      url: '/v1/assets',
      headers: as(w.sessions.skipper),
      payload: { name: 'Rescue Sighting Report', media_kind: 'video' },
    });
    expect(asset.statusCode, asset.body).toBe(201);
    assetId = asset.json().data.id;
    const version = await app.inject({
      method: 'POST',
      url: `/v1/assets/${assetId}/versions`,
      headers: as(w.sessions.skipper),
      payload: {},
    });
    expect(version.statusCode, version.body).toBe(201);
    // Point the version at some Bin bytes (bin-media is mocked; no FK on this column).
    await sql`UPDATE bay_asset_versions SET bin_asset_id = ${randomUUID()} WHERE asset_id = ${assetId}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (w) await destroyWorld(sql, w);
    await sql?.end({ timeout: 5 });
    const { connection } = await import('../src/db/index.js');
    await connection.end({ timeout: 5 });
  });

  async function mint(allowComments = true) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/review-links',
      headers: as(w.sessions.skipper),
      payload: { asset_id: assetId, allow_comments: allowComments },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data as { id: string; token: string; url: string; token_hash?: string };
  }

  const openBundle = (token: string) =>
    app.inject({ method: 'GET', url: '/v1/public/review', headers: { 'x-bay-review-token': token } });

  it('stores only a SHA-256 of the token, never the token', async () => {
    const link = await mint();
    expect(link.token).toMatch(/^[0-9a-f]{48}$/);
    expect(link.token_hash).toBeUndefined();

    const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'bay_review_links'`;
    expect(cols.map((c) => c.column_name)).not.toContain('token');
    const [row] = await sql`SELECT * FROM bay_review_links WHERE id = ${link.id}`;
    expect(row!.token_hash).toBe(sha256(link.token));
    expect(JSON.stringify(row)).not.toContain(link.token);
  });

  it("the share URL carries the token in the fragment, which browsers never send", async () => {
    const link = await mint();
    expect(link.url).toBe(`https://bigbluebam.test/bay/r#${link.token}`);
  });

  it('listing links returns no token, url or hash (the token is shown once, at mint)', async () => {
    await mint();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/review-links?asset_id=${assetId}`,
      headers: as(w.sessions.skipper),
    });
    expect(res.statusCode).toBe(200);
    for (const l of res.json().data) {
      expect(l).not.toHaveProperty('token');
      expect(l).not.toHaveProperty('url');
      expect(l).not.toHaveProperty('token_hash');
    }
  });

  it('a guest opens the review with the token in a header; the path form is gone', async () => {
    const link = await mint();
    const res = await openBundle(link.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.name).toBe('Rescue Sighting Report');
    expect(res.json().data.media_ticket).toEqual(expect.any(String));
    expect(res.json().data.media_ticket).not.toContain(link.token);

    expect((await app.inject({ method: 'GET', url: `/v1/public/review/${link.token}` })).statusCode).toBe(404);
  });

  it('a wrong, malformed or missing token is 404 without confirming anything exists', async () => {
    expect((await openBundle('0'.repeat(48))).statusCode).toBe(404);
    expect((await openBundle("' OR 1=1 --")).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/public/review' })).statusCode).toBe(404);
  });

  it('media streams against the ticket, refuses a tampered one, and stops when the link is revoked', async () => {
    const link = await mint();
    const ticket: string = (await openBundle(link.token)).json().data.media_ticket;
    const media = (t: string) =>
      app.inject({ method: 'GET', url: `/v1/public/review/media?ticket=${encodeURIComponent(t)}` });

    const ok = await media(ticket);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.body).toBe('coconut');

    const [id, exp] = ticket.split('.');
    expect((await media(`${id}.${Number(exp) + 1}.${ticket.split('.')[2]}`)).statusCode).toBe(404);
    expect((await media(link.token)).statusCode).toBe(404);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/review-links/${link.id}`,
      headers: as(w.sessions.skipper),
    });
    expect(revoke.statusCode).toBe(200);
    expect((await media(ticket)).statusCode).toBe(404);
    expect((await openBundle(link.token)).statusCode).toBe(404);
  });

  it('a guest comments with the token in a header, only when the link allows it', async () => {
    const open = await mint(true);
    const closed = await mint(false);
    const comment = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/public/review/comments',
        headers: { 'x-bay-review-token': token },
        payload: { guest_name: 'Mary Ann', body: 'The coconut pie is in frame at 0:42.' },
      });
    const res = await comment(open.token);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.is_guest).toBe(true);
    expect((await comment(closed.token)).statusCode).toBe(403);
  });

  it("migration 0340's SQL hash equals the service's, so links minted before it keep working", async () => {
    const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90011223344556677a';
    const [row] = await sql`SELECT encode(sha256(convert_to(${token}, 'UTF8')), 'hex') AS h`;
    const { hashReviewToken } = await import('../src/lib/review-token.js');
    expect(row!.h).toBe(hashReviewToken(token));
  });
});
