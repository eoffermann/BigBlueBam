// Issue #167: every per-diagram route enforces the diagram's own ACL, not just the
// org-wide blueprint.* grant. A member who is not a collaborator on a private
// diagram must not be able to list or add collaborators (self-promotion to owner),
// read or restore versions, read or write comments, or archive it; collaborator
// writes and archive are owner-only on every diagram; and only a comment's author
// (or the diagram owner) may rewrite its text.
//
// The real routes and the real diagram.service run against a small in-memory fake
// of the Drizzle query builder. drizzle-orm's eq/and are swapped for plain
// predicate objects so the fake can evaluate the service's WHERE clauses.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

vi.mock('drizzle-orm', async (importOriginal) => {
  const orig = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...orig,
    eq: (col: { name: string }, val: unknown) => ({ eqCol: col.name, val }),
    and: (...conds: unknown[]) => ({ and: conds }),
  };
});

vi.mock('../src/env.js', () => ({
  env: new Proxy({ NODE_ENV: 'test', PUBLIC_URL: 'http://localhost' } as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : undefined),
  }),
}));

vi.mock('@bigbluebam/shared', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, publishBoltEvent: vi.fn(async () => {}) };
});

type Row = Record<string, unknown>;
const state = {
  tables: new Map<unknown, Row[]>(),
  writes: [] as string[],
};

type Cond = { eqCol?: string; val?: unknown; and?: Cond[] } | undefined;
function matches(row: Row, cond: Cond): boolean {
  if (!cond) return true;
  if (cond.and) return cond.and.every((c) => matches(row, c));
  if (cond.eqCol !== undefined) return row[cond.eqCol] === cond.val;
  return true;
}

vi.mock('../src/db/index.js', () => {
  const rowsOf = (t: unknown) => state.tables.get(t) ?? [];
  const query = (initial: () => Row[]) => {
    let filter: Cond;
    let limit = Number.POSITIVE_INFINITY;
    const q = {
      where(c: Cond) {
        filter = c;
        return q;
      },
      limit(n: number) {
        limit = n;
        return q;
      },
      orderBy() {
        return q;
      },
      then(res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve(initial().filter((r) => matches(r, filter)).slice(0, limit)).then(res, rej);
      },
    };
    return q;
  };
  const db = {
    select: () => ({ from: (t: unknown) => query(() => rowsOf(t)) }),
    insert: (_t: unknown) => ({
      values(v: Row) {
        const q = {
          onConflictDoUpdate: () => q,
          onConflictDoNothing: () => q,
          returning: async () => {
            state.writes.push('insert');
            return [v];
          },
          then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
            state.writes.push('insert');
            return Promise.resolve(undefined).then(res, rej);
          },
        };
        return q;
      },
    }),
    update: (t: unknown) => ({
      set: (v: Row) => ({
        where: (c: Cond) => ({
          returning: async () => {
            state.writes.push('update');
            return rowsOf(t)
              .filter((r) => matches(r, c))
              .map((r) => ({ ...r, ...v }));
          },
        }),
      }),
    }),
    delete: (_t: unknown) => ({
      where: async () => {
        state.writes.push('delete');
      },
    }),
    execute: async () => [{ next_version: 1 }],
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      state.writes.push('transaction');
      return cb(db);
    },
  };
  return { db, connection: { end: vi.fn() } };
});

const ORG = '00000000-0000-0000-0000-0000000000aa';
const OWNER = '00000000-0000-0000-0000-000000000001';
const MEMBER = '00000000-0000-0000-0000-000000000002';
const EDITOR = '00000000-0000-0000-0000-000000000003';
const CO_OWNER = '00000000-0000-0000-0000-000000000004';
const ADMIN = '00000000-0000-0000-0000-000000000005';
const PRIVATE = '00000000-0000-0000-0000-00000000d001';
const SHARED = '00000000-0000-0000-0000-00000000d002';
const C_OWNER = '00000000-0000-0000-0000-00000000c001';
const C_SHARED = '00000000-0000-0000-0000-00000000c002';
// Issue #181: a Bam project, a member of it, and diagrams scoped to it.
const PROJECT = '00000000-0000-0000-0000-0000000000f1';
const PROJ_MEMBER = '00000000-0000-0000-0000-000000000006';
const PROJ_DIAG = '00000000-0000-0000-0000-00000000d003';
const UNSCOPED_PROJ_DIAG = '00000000-0000-0000-0000-00000000d004';

const ROLE_OF: Record<string, string> = {
  [OWNER]: 'member',
  [MEMBER]: 'member',
  [EDITOR]: 'member',
  [CO_OWNER]: 'member',
  [ADMIN]: 'admin',
  [PROJ_MEMBER]: 'member',
};

vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: FastifyRequest, reply: FastifyReply) => {
    const id = request.headers['x-test-user'];
    if (typeof id !== 'string') return reply.status(401).send({ error: { code: 'UNAUTHORIZED' } });
    (request as unknown as { user: unknown }).user = {
      id,
      org_id: ORG,
      role: ROLE_OF[id] ?? 'member',
      is_superuser: false,
      api_key_scope: null,
    };
  },
  requireScope: () => async () => {},
}));

let app: FastifyInstance;
let schema: typeof import('../src/db/schema/index.js');

beforeAll(async () => {
  schema = await import('../src/db/schema/index.js');
  app = Fastify();
  // The org-wide grant is not what is under test here: let every request
  // through it, so only the per-diagram ACL decides.
  app.decorate('requireCan', () => async () => {});
  app.decorate('redis', { publish: vi.fn(async () => 1) } as unknown as FastifyInstance['redis']);
  const mod = await import('../src/routes/diagrams.routes.js');
  await app.register(mod.default, { prefix: '/v1' });
  const cross = await import('../src/routes/cross-product.routes.js');
  await app.register(cross.default, { prefix: '/v1' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  state.writes = [];
  state.tables = new Map<unknown, Row[]>([
    [
      schema.blueprintDiagrams,
      [
        { id: PRIVATE, org_id: ORG, visibility: 'private', created_by: OWNER, name: 'Private' },
        { id: SHARED, org_id: ORG, visibility: 'organization', created_by: OWNER, name: 'Shared' },
        { id: PROJ_DIAG, org_id: ORG, visibility: 'project', project_id: PROJECT, created_by: OWNER, name: 'Project' },
        { id: UNSCOPED_PROJ_DIAG, org_id: ORG, visibility: 'project', project_id: null, created_by: OWNER, name: 'Unscoped' },
      ],
    ],
    [schema.projects, [{ id: PROJECT, org_id: ORG, name: 'Restricted' }]],
    [schema.projectMemberships, [{ id: 'pm1', project_id: PROJECT, user_id: PROJ_MEMBER }]],
    [schema.tasksStub, []],
    [
      schema.blueprintCollaborators,
      [
        { id: 'k1', diagram_id: PRIVATE, user_id: EDITOR, role: 'editor' },
        { id: 'k2', diagram_id: PRIVATE, user_id: CO_OWNER, role: 'owner' },
      ],
    ],
    [
      schema.blueprintComments,
      [
        { id: C_OWNER, diagram_id: PRIVATE, author_id: OWNER, body: 'owner note' },
        { id: C_SHARED, diagram_id: SHARED, author_id: OWNER, body: 'owner note' },
      ],
    ],
    [schema.blueprintDiagramVersions, [{ diagram_id: PRIVATE, version_number: 1, snapshot: { nodes: [], edges: [] } }]],
    [schema.blueprintNodes, []],
    [schema.blueprintEdges, []],
  ]);
});

function call(user: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: { 'x-test-user': user },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

describe('private diagram: a non-collaborator member is refused on every route (#167)', () => {
  const attacks: Array<[string, string, unknown?]> = [
    ['GET', `/v1/diagrams/${PRIVATE}/collaborators`],
    ['POST', `/v1/diagrams/${PRIVATE}/collaborators`, { user_id: MEMBER, role: 'owner' }],
    ['DELETE', `/v1/diagrams/${PRIVATE}/collaborators/${EDITOR}`],
    ['GET', `/v1/diagrams/${PRIVATE}/versions`],
    ['POST', `/v1/diagrams/${PRIVATE}/versions`, {}],
    ['POST', `/v1/diagrams/${PRIVATE}/versions/1/restore`],
    ['GET', `/v1/diagrams/${PRIVATE}/comments`],
    ['POST', `/v1/diagrams/${PRIVATE}/comments`, { body: 'hi' }],
    ['PATCH', `/v1/diagrams/${PRIVATE}/comments/${C_OWNER}`, { body: 'rewritten' }],
    ['PATCH', `/v1/diagrams/${PRIVATE}/comments/${C_OWNER}`, { resolved: true }],
    ['POST', `/v1/diagrams/${PRIVATE}/archive`],
    ['POST', `/v1/diagrams/${PRIVATE}/star`],
  ];
  it.each(attacks)('%s %s -> 403 with no write', async (method, url, payload) => {
    const res = await call(MEMBER, method, url, payload);
    expect(res.statusCode).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it('the self-promotion chain fails at its first step', async () => {
    const add = await call(MEMBER, 'POST', `/v1/diagrams/${PRIVATE}/collaborators`, { user_id: MEMBER, role: 'owner' });
    expect(add.statusCode).toBe(403);
    const rows = state.tables.get(schema.blueprintCollaborators)!;
    expect(rows.some((r) => r.user_id === MEMBER)).toBe(false);
  });
});

describe('ownership is required for collaborator writes and archive on every diagram', () => {
  it('a member cannot add or remove collaborators on an organization-visible diagram', async () => {
    expect((await call(MEMBER, 'POST', `/v1/diagrams/${SHARED}/collaborators`, { user_id: MEMBER, role: 'owner' })).statusCode).toBe(403);
    expect((await call(MEMBER, 'DELETE', `/v1/diagrams/${SHARED}/collaborators/${EDITOR}`)).statusCode).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it('a member cannot archive an organization-visible diagram they do not own', async () => {
    expect((await call(MEMBER, 'POST', `/v1/diagrams/${SHARED}/archive`)).statusCode).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it('an editor collaborator can read but not manage the private diagram', async () => {
    expect((await call(EDITOR, 'GET', `/v1/diagrams/${PRIVATE}/versions`)).statusCode).toBe(200);
    expect((await call(EDITOR, 'GET', `/v1/diagrams/${PRIVATE}/collaborators`)).statusCode).toBe(200);
    expect((await call(EDITOR, 'POST', `/v1/diagrams/${PRIVATE}/collaborators`, { user_id: EDITOR, role: 'owner' })).statusCode).toBe(403);
    expect((await call(EDITOR, 'POST', `/v1/diagrams/${PRIVATE}/archive`)).statusCode).toBe(403);
  });

  it('the creator, an owner collaborator and an org admin can manage', async () => {
    expect((await call(OWNER, 'POST', `/v1/diagrams/${PRIVATE}/collaborators`, { user_id: MEMBER, role: 'viewer' })).statusCode).toBe(201);
    expect((await call(CO_OWNER, 'DELETE', `/v1/diagrams/${PRIVATE}/collaborators/${EDITOR}`)).statusCode).toBe(200);
    expect((await call(ADMIN, 'POST', `/v1/diagrams/${PRIVATE}/archive`)).statusCode).toBe(200);
    expect((await call(OWNER, 'POST', `/v1/diagrams/${SHARED}/archive`)).statusCode).toBe(200);
  });
});

describe('changing visibility is owner-only (#179)', () => {
  it('an editor collaborator cannot widen a private diagram to the organization', async () => {
    const res = await call(EDITOR, 'PATCH', `/v1/diagrams/${PRIVATE}`, { visibility: 'organization' });
    expect(res.statusCode).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it('a member cannot lock everyone out of an organization-visible diagram', async () => {
    const res = await call(MEMBER, 'PATCH', `/v1/diagrams/${SHARED}`, { visibility: 'private' });
    expect(res.statusCode).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it('an editor may still rename, and may resend the unchanged visibility', async () => {
    expect((await call(EDITOR, 'PATCH', `/v1/diagrams/${PRIVATE}`, { name: 'Renamed' })).statusCode).toBe(200);
    expect((await call(EDITOR, 'PATCH', `/v1/diagrams/${PRIVATE}`, { name: 'Again', visibility: 'private' })).statusCode).toBe(200);
  });

  it('the creator, an owner collaborator and an org admin can change visibility', async () => {
    expect((await call(OWNER, 'PATCH', `/v1/diagrams/${PRIVATE}`, { visibility: 'organization' })).statusCode).toBe(200);
    expect((await call(CO_OWNER, 'PATCH', `/v1/diagrams/${PRIVATE}`, { visibility: 'project' })).statusCode).toBe(200);
    expect((await call(ADMIN, 'PATCH', `/v1/diagrams/${SHARED}`, { visibility: 'private' })).statusCode).toBe(200);
  });
});

describe('Bam project membership gates project diagrams and from-bam (#181)', () => {
  const nonMemberAttacks: Array<[string, string, unknown?]> = [
    ['GET', `/v1/diagrams/${PROJ_DIAG}`],
    ['GET', `/v1/diagrams/${PROJ_DIAG}/graph`],
    ['GET', `/v1/diagrams/${PROJ_DIAG}/nodes`],
    ['GET', `/v1/diagrams/${PROJ_DIAG}/export`],
    ['GET', `/v1/diagrams/${PROJ_DIAG}/comments`],
    ['PATCH', `/v1/diagrams/${PROJ_DIAG}`, { name: 'hijacked' }],
    ['POST', `/v1/diagrams/${PROJ_DIAG}/comments`, { body: 'hi' }],
    ['POST', `/v1/diagrams/${PROJ_DIAG}/versions`, {}],
    ['POST', `/v1/diagrams/${PROJ_DIAG}/promote-to-tasks`, { project_id: PROJECT }],
    ['POST', '/v1/diagrams/from-bam', { project_id: PROJECT, include_completed: true }],
  ];
  it.each(nonMemberAttacks)('a non-member org member: %s %s -> 403 with no write', async (method, url, payload) => {
    const res = await call(MEMBER, method, url, payload);
    expect(res.statusCode).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it('a project member reads and edits the project diagram', async () => {
    expect((await call(PROJ_MEMBER, 'GET', `/v1/diagrams/${PROJ_DIAG}/graph`)).statusCode).toBe(200);
    expect((await call(PROJ_MEMBER, 'PATCH', `/v1/diagrams/${PROJ_DIAG}`, { name: 'v2' })).statusCode).toBe(200);
  });

  it('an org admin and the creator read it without a membership row', async () => {
    expect((await call(ADMIN, 'GET', `/v1/diagrams/${PROJ_DIAG}`)).statusCode).toBe(200);
    expect((await call(OWNER, 'GET', `/v1/diagrams/${PROJ_DIAG}`)).statusCode).toBe(200);
  });

  it('a project diagram with no project_id stays org-wide', async () => {
    expect((await call(MEMBER, 'GET', `/v1/diagrams/${UNSCOPED_PROJ_DIAG}`)).statusCode).toBe(200);
  });

  it('the list hides the project diagram from a non-member and shows it to a member', async () => {
    // include_archived only because the fake rows carry no is_archived column.
    const ids = async (u: string) =>
      ((await call(u, 'GET', '/v1/diagrams?include_archived=true')).json().data as Array<{ id: string }>).map((d) => d.id);
    expect(await ids(MEMBER)).not.toContain(PROJ_DIAG);
    expect(await ids(MEMBER)).toContain(UNSCOPED_PROJ_DIAG);
    expect(await ids(PROJ_MEMBER)).toContain(PROJ_DIAG);
    expect(await ids(ADMIN)).toContain(PROJ_DIAG);
  });

  it('from-bam lets a project member past the gate (404 here only because the fake project has no tasks)', async () => {
    const res = await call(PROJ_MEMBER, 'POST', '/v1/diagrams/from-bam', { project_id: PROJECT, include_completed: true });
    expect(res.statusCode).toBe(404);
  });
});

describe('a star is not a read grant (#180)', () => {
  const starred = async (u: string) =>
    ((await call(u, 'GET', '/v1/diagrams?starred=true&include_archived=true')).json().data as Array<{ id: string }>).map(
      (d) => d.id,
    );

  it('a removed collaborator no longer sees the private diagram in their starred list', async () => {
    state.tables.set(schema.blueprintStars, [
      { diagram_id: PRIVATE, user_id: EDITOR },
      { diagram_id: SHARED, user_id: EDITOR },
    ]);
    expect(await starred(EDITOR)).toEqual(expect.arrayContaining([PRIVATE, SHARED]));
    state.tables.set(
      schema.blueprintCollaborators,
      state.tables.get(schema.blueprintCollaborators)!.filter((r) => r.user_id !== EDITOR),
    );
    const after = await starred(EDITOR);
    expect(after).not.toContain(PRIVATE);
    expect(after).toContain(SHARED);
  });

  it('a pre-#167 star on a private or non-member project diagram does not list it', async () => {
    state.tables.set(schema.blueprintStars, [
      { diagram_id: PRIVATE, user_id: MEMBER },
      { diagram_id: PROJ_DIAG, user_id: MEMBER },
    ]);
    expect(await starred(MEMBER)).toEqual([]);
  });
});

describe('comment edits are author-or-owner', () => {
  it("a member cannot rewrite another user's comment on a shared diagram", async () => {
    const res = await call(MEMBER, 'PATCH', `/v1/diagrams/${SHARED}/comments/${C_SHARED}`, { body: 'rewritten' });
    expect(res.statusCode).toBe(403);
    expect(state.writes).toEqual([]);
  });

  it('a member may resolve a comment on a diagram they can comment on', async () => {
    const res = await call(MEMBER, 'PATCH', `/v1/diagrams/${SHARED}/comments/${C_SHARED}`, { resolved: true });
    expect(res.statusCode).toBe(200);
  });

  it('the author edits their own comment; an editor cannot edit the owner one', async () => {
    expect((await call(OWNER, 'PATCH', `/v1/diagrams/${PRIVATE}/comments/${C_OWNER}`, { body: 'v2' })).statusCode).toBe(200);
    expect((await call(EDITOR, 'PATCH', `/v1/diagrams/${PRIVATE}/comments/${C_OWNER}`, { body: 'v3' })).statusCode).toBe(403);
    expect((await call(CO_OWNER, 'PATCH', `/v1/diagrams/${PRIVATE}/comments/${C_OWNER}`, { body: 'v4' })).statusCode).toBe(200);
  });
});
