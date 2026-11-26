/**
 * The compile call's output budget (#237): ONE value for production (env BASTION_LLM_MAX_TOKENS
 * defaults to it), the corpus recorder and the live gate, so they cannot drift. Reasoning models
 * spend part of the budget thinking before they answer; at 2048 the recorded model was cut off
 * on 30 of 48 controls, usually before writing anything. No imports: env.ts reads it.
 */
export const COMPILE_MAX_TOKENS_DEFAULT = 8192;
