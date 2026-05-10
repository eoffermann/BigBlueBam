import { describe, it, expect, vi } from 'vitest';
import { dualReadGate, shadowOnly } from '../src/middleware/dual-read.js';

// ─────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────
//
// dualReadGate takes a legacy preHandler and a permission ID, runs both
// the legacy gate and (via fastify.requireCan decoration) the resolver
// in shadow. We don't need a real Fastify instance for the unit tests —
// just enough surface area on `this`, `request`, and `reply` to exercise
// the wrapper's branching.

function makeReply() {
  let sentPayload: unknown = undefined;
  const reply = {
    sent: false,
    statusCode: 200,
    code(c: number) {
      this.statusCode = c;
      return this;
    },
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    send(payload: unknown) {
      this.sent = true;
      sentPayload = payload;
      return this;
    },
    payload: () => sentPayload,
  };
  return reply;
}

function makeRequest() {
  return {
    id: 'req-test-1',
    method: 'POST' as const,
    url: '/projects',
    routeOptions: { url: '/projects' },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
  } as unknown as Parameters<ReturnType<typeof dualReadGate>>[0] extends infer T ? never : never;
}

function makeFakeFastify(opts: {
  requireCan?: (id: string) => (req: unknown, reply: unknown) => Promise<void>;
}) {
  return {
    requireCan: opts.requireCan,
  };
}

describe('dualReadGate', () => {
  it('legacy passes (no reply.send) → request.legacyPermissionDecision = "allow", resolver runs', async () => {
    const legacyCalls = [] as string[];
    const legacy = vi.fn(async () => {
      legacyCalls.push('legacy');
      // pass-through: no reply.send call
    });
    const requireCanCalls = [] as string[];
    const requireCan = (id: string) => async () => {
      requireCanCalls.push(id);
    };
    const wrapper = dualReadGate({ legacy, permission: 'bam.task.create' });
    const reply = makeReply();
    const request = { id: 'r1', log: { warn: vi.fn() } } as unknown as Parameters<typeof wrapper>[0];

    const fastify = makeFakeFastify({ requireCan });
    await wrapper.call(fastify as unknown as Parameters<typeof wrapper> extends [infer T, ...unknown[]] ? T : never, request, reply as unknown as Parameters<typeof wrapper>[1]);

    expect(legacyCalls).toEqual(['legacy']);
    expect(requireCanCalls).toEqual(['bam.task.create']);
    expect((request as unknown as { legacyPermissionDecision: string }).legacyPermissionDecision).toBe('allow');
    expect(reply.sent).toBe(false);
  });

  it('legacy denies (reply.code(403).send) → legacyPermissionDecision = "deny", resolver still runs', async () => {
    const legacy = vi.fn(async function (this: unknown, _req: unknown, reply: ReturnType<typeof makeReply>) {
      reply.code(403).send({ error: { code: 'FORBIDDEN' } });
    });
    const requireCanCalls = [] as string[];
    const requireCan = (id: string) => async () => {
      requireCanCalls.push(id);
    };
    const wrapper = dualReadGate({ legacy: legacy as unknown as Parameters<typeof dualReadGate>[0]['legacy'], permission: 'bam.task.delete' });
    const reply = makeReply();
    const request = { id: 'r2', log: { warn: vi.fn() } } as unknown as Parameters<typeof wrapper>[0];
    const fastify = makeFakeFastify({ requireCan });
    await wrapper.call(fastify as unknown as Parameters<typeof wrapper> extends [infer T, ...unknown[]] ? T : never, request, reply as unknown as Parameters<typeof wrapper>[1]);

    expect((request as unknown as { legacyPermissionDecision: string }).legacyPermissionDecision).toBe('deny');
    expect(reply.sent).toBe(true);
    expect(reply.statusCode).toBe(403);
    // Resolver still runs even on legacy denial — divergence telemetry
    // needs to record the resolver's verdict.
    expect(requireCanCalls).toEqual(['bam.task.delete']);
  });

  it('resolver throws → legacy verdict stands, error logged', async () => {
    const legacy = vi.fn(async () => { /* pass */ });
    const requireCan = () => async () => {
      throw new Error('boom');
    };
    const wrapper = dualReadGate({ legacy, permission: 'bam.x.y' });
    const reply = makeReply();
    const warn = vi.fn();
    const request = { id: 'r3', log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() } } as unknown as Parameters<typeof wrapper>[0];
    const fastify = makeFakeFastify({ requireCan });

    await wrapper.call(fastify as unknown as Parameters<typeof wrapper> extends [infer T, ...unknown[]] ? T : never, request, reply as unknown as Parameters<typeof wrapper>[1]);

    expect((request as unknown as { legacyPermissionDecision: string }).legacyPermissionDecision).toBe('allow');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ permission: 'bam.x.y' }),
      expect.stringContaining('resolver threw'),
    );
  });

  it('host has no requireCan decoration → wrapper is a no-op for resolver but still records legacy', async () => {
    const legacy = vi.fn(async () => { /* pass */ });
    const wrapper = dualReadGate({ legacy, permission: 'bam.task.list' });
    const reply = makeReply();
    const request = { id: 'r4', log: { warn: vi.fn() } } as unknown as Parameters<typeof wrapper>[0];
    const fastify = makeFakeFastify({}); // no requireCan

    await wrapper.call(fastify as unknown as Parameters<typeof wrapper> extends [infer T, ...unknown[]] ? T : never, request, reply as unknown as Parameters<typeof wrapper>[1]);

    expect((request as unknown as { legacyPermissionDecision: string }).legacyPermissionDecision).toBe('allow');
  });
});

describe('shadowOnly', () => {
  it('marks legacy as allow and runs requireCan', async () => {
    const requireCanCalls = [] as string[];
    const requireCan = (id: string) => async () => {
      requireCanCalls.push(id);
    };
    const wrapper = shadowOnly('bam.task.list');
    const reply = makeReply();
    const request = {} as unknown as Parameters<typeof wrapper>[0];
    const fastify = makeFakeFastify({ requireCan });

    await wrapper.call(fastify as unknown as Parameters<typeof wrapper> extends [infer T, ...unknown[]] ? T : never, request, reply as unknown as Parameters<typeof wrapper>[1]);

    expect((request as unknown as { legacyPermissionDecision: string }).legacyPermissionDecision).toBe('allow');
    expect(requireCanCalls).toEqual(['bam.task.list']);
  });
});
