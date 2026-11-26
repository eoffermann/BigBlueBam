// Production wiring for the M7 compile: the internal LLM proxy client, the leased Redis permits,
// the cross-replica slice lock, and the route-level choice between the AI compile on the worker
// and M3's inline deterministic compile (same 202 contract either way).

import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { orgTx } from '../engine/context.js';
import { engineDeps } from '../engine/runtime.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { llmChat } from '../lib/llm-client.js';
import { createLlmPermits } from '../lib/llm-permits.js';
import { enqueueCompileRun } from '../lib/queue.js';
import { compileFramework, type CompileLogger } from './compile.service.js';
import { type CompileAiDeps, createQueuedAiRun, resolveLlmProviderId, type SliceLock } from './compile-ai.service.js';
import { isUniqueViolation } from './shared.js';
import type { Viewer } from './types.js';

function redisSliceLock(redis: Redis): SliceLock {
  const key = (runId: string) => `bastion:compile:slice:${runId}`;
  return {
    // Fail open on a Redis error: the in-process map still prevents a second slice here, and the
    // run claim still fences every write.
    acquire: async (runId, ttlMs) => (await redis.set(key(runId), String(process.pid), 'PX', ttlMs, 'NX').catch(() => 'OK')) === 'OK',
    release: async (runId) => {
      await redis.del(key(runId)).catch(() => undefined);
    },
  };
}

export function compileAiDeps(log: FastifyBaseLogger, redis: Redis): CompileAiDeps {
  return {
    engine: engineDeps(log, redis),
    llm: llmChat,
    permits: createLlmPermits(redis, { log }),
    sliceLock: redisSliceLock(redis),
    background: true,
  };
}

/**
 * POST /frameworks/:id/compile (row 9). With an AI provider and `use_ai` not false: a queued run
 * for the worker (202, status `queued`; poll compile-runs). Otherwise the M3 inline compile (202,
 * finished run with used_fallback = true).
 */
export async function startCompile(
  log: FastifyBaseLogger,
  redis: Redis,
  viewer: Viewer,
  frameworkId: string,
  opts: { use_ai?: boolean },
  compileLog?: CompileLogger,
) {
  if (opts.use_ai !== false) {
    const engine = engineDeps(log, redis);
    const providerId = await orgTx(engine.sql, viewer.org_id, async (tx) => {
      const f = (await tx`SELECT status FROM bastion_frameworks WHERE organization_id = ${viewer.org_id} AND id = ${frameworkId}`)[0];
      if (!f) throw new NotFoundError('We could not find that framework.');
      if (f.status === 'archived') throw new ConflictError('This framework is archived.', 'FRAMEWORK_ARCHIVED');
      return resolveLlmProviderId(tx, viewer.org_id);
    });
    if (providerId) {
      let run: Record<string, unknown>;
      try {
        run = await orgTx(engine.sql, viewer.org_id, (tx) => createQueuedAiRun(tx, viewer.org_id, frameworkId, viewer.id, providerId));
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictError('A setup run is already going for this framework.', 'COMPILE_RUNNING');
        throw err;
      }
      const queued = await enqueueCompileRun({ organization_id: viewer.org_id, run_id: String(run.id), resume_count: 0 });
      log.info({ run_id: run.id, framework_id: frameworkId, queued }, 'bastion-compile: AI compile queued for the worker');
      return { data: run };
    }
  }
  return compileFramework(viewer, frameworkId, compileLog);
}
