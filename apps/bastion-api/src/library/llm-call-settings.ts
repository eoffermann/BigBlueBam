/**
 * Bastion's LLM call settings: ONE entry per kind of call (#263, #264; #237 for compile; #257 for
 * the deadline). Production, the corpus recorders and the live gates all read this file, so the
 * output budget a gate validates is the budget production sends, and an operator override reaches
 * every consumer of that kind.
 *
 *   compile              the setup compile's tailoring call (one per control)
 *   questionnaire_draft  one questionnaire answer (autofill and POST /answers/draft)
 *   fix_reword           the plain-words rewording of a drafted fix
 *
 * maxTokensDefault: reasoning models spend part of the budget thinking before they answer. The
 *   compile was raised to 8192 after the recorded model was cut off on 30 of 48 controls at 2048.
 *   The questionnaire and reword corpora were recorded at 2048 (meta.max_tokens in their JSON);
 *   raising either value means re-recording that corpus, which its replay gate enforces.
 * maxTokensEnv: the operator override for that kind (env.ts validates it with the bounds below;
 *   recorders and gates read it with llmMaxTokens()). A cut-off warning names this variable.
 * deadlineMs: how long Bastion waits for one call of that kind. compile and questionnaire_draft
 *   follow BASTION_LLM_TIMEOUT_MS, whose default and bounds are the suite-wide deadline fact in
 *   @bigbluebam/shared (llm-deadline.ts, #257; the proxy applies the same value upstream);
 *   fix_reword is shorter because a person is waiting on the request.
 *
 * Imports only the shared deadline fact: env.ts reads this module.
 */

import { LLM_CALL_TIMEOUT_DEFAULT_MS, llmCallDeadlineMs } from '@bigbluebam/shared';

export type BastionLlmCallKind = 'compile' | 'questionnaire_draft' | 'fix_reword';

export interface BastionLlmCallSetting {
  maxTokensDefault: number;
  maxTokensEnv: string;
  deadlineMs: number;
  deadlineEnv: string | null;
}

export const LLM_MAX_TOKENS_MIN = 256;
export const LLM_MAX_TOKENS_MAX = 100_000;

export const BASTION_LLM_CALLS: Readonly<Record<BastionLlmCallKind, BastionLlmCallSetting>> = {
  compile: { maxTokensDefault: 8192, maxTokensEnv: 'BASTION_LLM_MAX_TOKENS', deadlineMs: LLM_CALL_TIMEOUT_DEFAULT_MS, deadlineEnv: 'BASTION_LLM_TIMEOUT_MS' },
  questionnaire_draft: {
    maxTokensDefault: 2048,
    maxTokensEnv: 'BASTION_QUESTIONNAIRE_MAX_TOKENS',
    deadlineMs: LLM_CALL_TIMEOUT_DEFAULT_MS,
    deadlineEnv: 'BASTION_LLM_TIMEOUT_MS',
  },
  fix_reword: { maxTokensDefault: 2048, maxTokensEnv: 'BASTION_REWORD_MAX_TOKENS', deadlineMs: 25_000, deadlineEnv: null },
};

/**
 * The max_tokens a call of this kind sends, from the environment (the kind's own variable) or the
 * default. Recorders and live gates call this with process.env; production gets the same value
 * through env.ts. Throws on a value env.ts would also refuse, so a recorder cannot run at a budget
 * production could never use.
 */
export function llmMaxTokens(kind: BastionLlmCallKind, source: Record<string, string | undefined> = {}): number {
  const s = BASTION_LLM_CALLS[kind];
  const raw = source[s.maxTokensEnv];
  if (raw === undefined || raw === '') return s.maxTokensDefault;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < LLM_MAX_TOKENS_MIN || n > LLM_MAX_TOKENS_MAX) {
    throw new Error(`${s.maxTokensEnv} must be a whole number from ${LLM_MAX_TOKENS_MIN} to ${LLM_MAX_TOKENS_MAX}, not "${raw}"`);
  }
  return n;
}

/**
 * How long one call of this kind may take, from its deadline variable (if any) or the default,
 * clamped exactly as the proxy clamps it (llmCallDeadlineMs).
 */
export function llmDeadlineMs(kind: BastionLlmCallKind, source: Record<string, string | undefined> = {}): number {
  const s = BASTION_LLM_CALLS[kind];
  const raw = s.deadlineEnv ? source[s.deadlineEnv] : undefined;
  const n = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return llmCallDeadlineMs(Number.isFinite(n) ? n : s.deadlineMs);
}
