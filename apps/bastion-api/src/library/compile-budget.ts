/**
 * The compile call's output budget (#237). The value lives in llm-call-settings.ts with every other
 * Bastion call kind (#263, #264), so production (env BASTION_LLM_MAX_TOKENS defaults to it), the
 * corpus recorder and the live gate cannot drift. Kept as a name because compile code imports it.
 * No imports beyond that module: env.ts reads it.
 */
import { BASTION_LLM_CALLS } from './llm-call-settings.js';

export const COMPILE_MAX_TOKENS_DEFAULT = BASTION_LLM_CALLS.compile.maxTokensDefault;
