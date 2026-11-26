// The fix-draft reworder (spec 2.4, M8): one bounded AI call per drafted fix, best effort. It
// never waits for an AI slot (a person is waiting on the request) and gives up after
// REWORD_TIMEOUT_MS; any failure, a busy slot, no provider or a refusal by the injection gate
// keeps the template's words. Built from injected parts so the gate is tested with recorded answers.

import type { LlmChat } from '../lib/llm-errors.js';
import type { LlmPermits } from '../lib/llm-permits.js';
import { buildRewordMessages, parseReword, type Reworded, type RewordInput } from '../library/fix-reword.js';

export const REWORD_TIMEOUT_MS = 25_000;

export interface ReworderParts {
  resolveProvider: (orgId: string) => Promise<string | null>;
  permits: LlmPermits;
  llm: LlmChat;
  log: { info(obj: object, msg?: string): void };
  timeoutMs?: number;
}

export function createReworder(p: ReworderParts) {
  return async (orgId: string, input: RewordInput): Promise<Reworded | null> => {
    const providerId = await p.resolveProvider(orgId).catch(() => null);
    if (!providerId) return null;
    const admission = await p.permits.tryAdmit(orgId);
    if (!admission.admitted) {
      p.log.info({ organization_id: orgId }, 'bastion-fix: every AI slot is busy; the drafted fix keeps the template words');
      return null;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const res = await Promise.race([
        p.llm({ providerId, messages: buildRewordMessages(input), maxTokens: 2048 }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), p.timeoutMs ?? REWORD_TIMEOUT_MS);
        }),
      ]);
      const parsed = parseReword(input, res.content, res.finish_reason);
      if (!parsed.ok) {
        p.log.info({ organization_id: orgId, template: input.template }, `bastion-fix: AI rewording not used (${parsed.reason})`);
        return null;
      }
      return parsed.value;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      await admission.release();
    }
  };
}
