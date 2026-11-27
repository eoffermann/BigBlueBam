import { z } from 'zod';
import { DEFAULT_PAGINATION_LIMIT, MAX_PAGINATION_LIMIT } from '../constants/index.js';

export const uuidSchema = z.string().uuid();

export const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const sortSchema = z.string();

/* ------------------------------------------------------------------ */
/*  String flags -> booleans (#215, #231, #251)                        */
/* ------------------------------------------------------------------ */
//
// The one place a string flag becomes a boolean. Never use z.coerce.boolean(): it runs JS
// Boolean(), which is true for ANY non-empty string, so 'false' parses as true. That inverted
// filters (#215, #231), sent Secure cookies over HTTP after COOKIE_SECURE=false (the api env.ts
// incident), and failed open on BIN_ALLOW_UNSCANNED_ACCESS=false (#251). scripts/check-no-coerce-
// boolean.mjs fails CI on any z.coerce.boolean under apps/*/src or packages/*/src.

/**
 * A boolean query parameter: 'true' / 'false' (or a real boolean) only. Anything else is a
 * validation error, so a typo is refused instead of silently picking a side.
 */
export const boolQueryParam = () =>
  z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

const ENV_TRUE = new Set(['true', '1', 'yes', 'on']);
const ENV_FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * How an environment string becomes a boolean: true/1/yes/on and false/0/no/off (any case,
 * surrounding whitespace ignored); '' and unset mean "not set". Any other string is returned
 * unchanged so the z.boolean() it feeds refuses it and the service fails at boot.
 */
export function parseEnvBool(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const v = value.trim().toLowerCase();
  if (v === '') return undefined;
  if (ENV_TRUE.has(v)) return true;
  if (ENV_FALSE.has(v)) return false;
  return value;
}

/**
 * An environment flag. `envBool(false)` defaults to false when unset or empty; `envBool()` leaves
 * it undefined so the caller can derive a default (e.g. COOKIE_SECURE from NODE_ENV).
 */
export function envBool(): z.ZodEffects<z.ZodOptional<z.ZodBoolean>, boolean | undefined, unknown>;
export function envBool(defaultValue: boolean): z.ZodEffects<z.ZodDefault<z.ZodBoolean>, boolean, unknown>;
export function envBool(defaultValue?: boolean) {
  return defaultValue === undefined
    ? z.preprocess(parseEnvBool, z.boolean().optional())
    : z.preprocess(parseEnvBool, z.boolean().default(defaultValue));
}

/**
 * Reads one boolean environment flag through envBool, for code that runs outside a service's
 * env.ts schema (boot hooks, the migrate runner) (#302). An unrecognized value throws, so a
 * spelling like BBB_RLS_ENFORCE=enabled refuses to boot instead of silently choosing a side.
 * Never compare an env flag to '1' / 'true' by hand: scripts/check-no-coerce-boolean.mjs fails
 * CI on `env.X === '1'` style reads.
 */
export function envFlag(
  name: string,
  source: Record<string, string | undefined>,
  defaultValue = false,
): boolean {
  const parsed = envBool(defaultValue).safeParse(source[name]);
  if (!parsed.success) {
    throw new Error(
      `${name}=${JSON.stringify(source[name])} is not a boolean flag; use true/false, 1/0, yes/no or on/off`,
    );
  }
  return parsed.data;
}

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGINATION_LIMIT)
    .default(DEFAULT_PAGINATION_LIMIT)
    .optional(),
});

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.record(z.unknown())).optional(),
    request_id: z.string(),
    // 500-class envelopes carry a fresh internal_error_id so an end user
    // pasting the failure id gives the operator a single grep target in
    // the structured logs without leaking the cause in the HTTP response.
    // See Platform_Plan.md (2026-04-13-revised) gap 2.3.2.
    internal_error_id: z.string().uuid().optional(),
  }),
});
