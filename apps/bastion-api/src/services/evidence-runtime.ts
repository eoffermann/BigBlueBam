// Production wiring for the M5 evidence services: Bin's bucket (read-only), the can_access
// preflight through the shared visibility client, and the two BullMQ producers. Built once.

import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { preflightAccess } from '@bigbluebam/shared/visibility-client';
import { llmHoldWindowMs } from '@bigbluebam/shared';
import { env } from '../env.js';
import { engineDeps } from '../engine/runtime.js';
import { enqueueEvaluationRun, enqueueEvidenceIngest } from '../lib/queue.js';
import { createBinStorage } from '../lib/storage.js';
import { binLookups, type EvidenceDeps } from './evidence-deps.js';
import type { DecisionDeps } from './decisions.service.js';
import type { PolicyDeps } from './policies.service.js';
import { pinPolicyChecks } from './policy-pins.js';
import { orgTx } from '../engine/context.js';
import { llmChat } from '../lib/llm-client.js';
import { createLlmPermits } from '../lib/llm-permits.js';
import { resolveLlmProviderId } from './compile-ai.service.js';
import { createReworder } from './fix-reword.service.js';

let binStorage: ReturnType<typeof createBinStorage> | undefined;

/** can_access through the api's internal preflight (fail closed). */
export const canAccess = (asker: string, entityType: string, entityId: string) =>
  preflightAccess(asker, entityType, entityId, {
    apiInternalUrl: env.BBB_API_INTERNAL_URL,
    internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
    timeoutMs: 5000,
  });

export function evidenceDeps(log: FastifyBaseLogger, redis: Redis): EvidenceDeps {
  if (binStorage === undefined) binStorage = createBinStorage(env);
  return {
    engine: engineDeps(log, redis),
    binStorage,
    bin: (tx) => binLookups(tx, canAccess),
    enqueueRuns: async (runs) => {
      for (const r of runs) await enqueueEvaluationRun(r);
    },
    enqueueIngest: async (orgId, id) => {
      await enqueueEvidenceIngest(orgId, id);
    },
  };
}

/** M6: what the gap, fix and exception services need (spec 2.4, 2.6). */
export function decisionDeps(log: FastifyBaseLogger, redis: Redis): DecisionDeps {
  const engine = engineDeps(log, redis);
  return {
    engine,
    canAccess,
    // M8 (spec 2.4): the AI may reword drafted fixes; the template's words stay on any failure.
    reword: createReworder({
      resolveProvider: (orgId) => orgTx(engine.sql, orgId, (tx) => resolveLlmProviderId(tx, orgId)),
      permits: createLlmPermits(redis, { log, holdMs: llmHoldWindowMs(env.BASTION_LLM_TIMEOUT_MS) }),
      llm: llmChat,
      log,
    }),
  };
}

/** M7: what the policy and attestation services need (spec 3.6). */
export function policyDeps(log: FastifyBaseLogger, redis: Redis): PolicyDeps {
  return {
    engine: engineDeps(log, redis),
    canAccess,
    enqueueRuns: async (runs) => {
      for (const r of runs) await enqueueEvaluationRun(r);
    },
    pinChecks: (viewer, controlId, policyId) => pinPolicyChecks(engineDeps(log, redis).sql, viewer, controlId, policyId),
  };
}

/** BASTION_BACKUP_S3_* set (spec 9.7): drives the "off-site backup not configured" banner. */
export function offsiteBackupConfigured(): boolean {
  return !!(env.BASTION_BACKUP_S3_BUCKET && env.BASTION_BACKUP_S3_ENDPOINT && env.BASTION_BACKUP_S3_ACCESS_KEY && env.BASTION_BACKUP_S3_SECRET_KEY);
}
