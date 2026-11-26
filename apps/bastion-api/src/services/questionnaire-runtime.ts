// Production wiring for M8: Bin's bucket (read-only) and the Bin access checks for questionnaire
// files, the can_access preflight, the autofill producer, and the autofill engine's LLM client,
// leased permits and cross-replica slice lock (shared with the M7 compile).

import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { env } from '../env.js';
import { engineDeps } from '../engine/runtime.js';
import { llmChat } from '../lib/llm-client.js';
import { createLlmPermits } from '../lib/llm-permits.js';
import { enqueueQuestionnaireAutofill } from '../lib/queue.js';
import { createBinStorage } from '../lib/storage.js';
import { redisSliceLock } from './compile-runtime.js';
import { binLookups } from './evidence-deps.js';
import { canAccess } from './evidence-runtime.js';
import type { AutofillDeps } from './questionnaire-autofill.service.js';
import type { QuestionnaireDeps } from './questionnaires.service.js';

let binStorage: ReturnType<typeof createBinStorage> | undefined;

export function questionnaireDeps(log: FastifyBaseLogger, redis: Redis): QuestionnaireDeps {
  if (binStorage === undefined) binStorage = createBinStorage(env);
  return {
    engine: engineDeps(log, redis),
    canAccess,
    binStorage,
    bin: (tx) => binLookups(tx, canAccess),
    enqueueAutofill: enqueueQuestionnaireAutofill,
  };
}

export function autofillDeps(log: FastifyBaseLogger, redis: Redis): AutofillDeps {
  return {
    engine: engineDeps(log, redis),
    llm: llmChat,
    permits: createLlmPermits(redis, { log }),
    sliceLock: redisSliceLock(redis, 'bastion:autofill:slice:'),
    canAccess,
    background: true,
  };
}
