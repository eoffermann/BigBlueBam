/**
 * password-generator.service — single source of truth for every
 * server-side password the platform mints (admin-issued resets, CLI
 * `reset-password`, future flows).
 *
 * The default behaviour is the pre-existing 16-char confusable-safe
 * alphanumeric — so callers that never configure a policy see no change.
 * SuperUsers can switch the platform to passphrase-style passwords
 * (Diceware-style word lists) or tune the alphanumeric length via the
 * `password_policy` row in system_settings.
 *
 * Storage shape (JSON under system_settings key `password_policy`):
 *
 *   {
 *     "mode": "alphanumeric" | "passphrase",
 *     "alphanumeric": {
 *       "length": 16          // 12..64
 *     },
 *     "passphrase": {
 *       "word_count": 4,       // 3..8
 *       "separator": "-",      // 0..3 chars
 *       "capitalize_words": true,
 *       "digit_count": 2,      // 0..4 trailing digits
 *       "append_symbol": true  // appends one symbol from a small set
 *     }
 *   }
 *
 * Read path is cached (in-process, 15s TTL) so the hot `reset-password`
 * route doesn't query system_settings on every call. The PUT handler
 * for `password_policy` calls `clearPolicyCache()` so SuperUser edits
 * land immediately.
 */

import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { PASSPHRASE_WORDS } from './password-words.js';

// ─── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
// Small, unambiguous symbol set. Excludes anything that's easy to confuse
// with a letter or a digit on common keyboards (e.g. l vs I vs |, O vs 0).
const SYMBOL_SET = '!@#$%^&*?+=';

export interface AlphanumericPolicy {
  length: number;
}

export interface PassphrasePolicy {
  word_count: number;
  separator: string;
  capitalize_words: boolean;
  digit_count: number;
  append_symbol: boolean;
}

export interface PasswordPolicy {
  mode: 'alphanumeric' | 'passphrase';
  alphanumeric: AlphanumericPolicy;
  passphrase: PassphrasePolicy;
}

export const DEFAULT_POLICY: PasswordPolicy = {
  mode: 'alphanumeric',
  alphanumeric: { length: 16 },
  passphrase: {
    word_count: 4,
    separator: '-',
    capitalize_words: true,
    digit_count: 2,
    append_symbol: true,
  },
};

// ─── Cache ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 15_000;
let cache: { value: PasswordPolicy; expiresAt: number } | null = null;

export function clearPolicyCache(): void {
  cache = null;
}

// ─── Policy load ────────────────────────────────────────────────────────

/**
 * Coerce an arbitrary JSON value into a fully-formed PasswordPolicy.
 * Anything missing falls back to the default; anything out of range is
 * clamped. Exported so the API's preview route can drive the generator
 * with a draft policy without persisting it first.
 */
export function normalizePolicy(raw: unknown): PasswordPolicy {
  const out: PasswordPolicy = JSON.parse(JSON.stringify(DEFAULT_POLICY));
  if (!raw || typeof raw !== 'object') return out;
  const v = raw as Record<string, unknown>;

  if (v.mode === 'passphrase' || v.mode === 'alphanumeric') {
    out.mode = v.mode;
  }
  if (v.alphanumeric && typeof v.alphanumeric === 'object') {
    const a = v.alphanumeric as Record<string, unknown>;
    if (typeof a.length === 'number' && Number.isFinite(a.length)) {
      out.alphanumeric.length = clamp(Math.round(a.length), 12, 64);
    }
  }
  if (v.passphrase && typeof v.passphrase === 'object') {
    const p = v.passphrase as Record<string, unknown>;
    if (typeof p.word_count === 'number' && Number.isFinite(p.word_count)) {
      out.passphrase.word_count = clamp(Math.round(p.word_count), 3, 8);
    }
    if (typeof p.separator === 'string') {
      out.passphrase.separator = p.separator.slice(0, 3);
    }
    if (typeof p.capitalize_words === 'boolean') {
      out.passphrase.capitalize_words = p.capitalize_words;
    }
    if (typeof p.digit_count === 'number' && Number.isFinite(p.digit_count)) {
      out.passphrase.digit_count = clamp(Math.round(p.digit_count), 0, 4);
    }
    if (typeof p.append_symbol === 'boolean') {
      out.passphrase.append_symbol = p.append_symbol;
    }
  }
  return out;
}

/**
 * Returns the effective password policy. Reads system_settings; on any
 * DB error returns the default so the hot reset path never blocks on a
 * config-table glitch.
 */
export async function getPasswordPolicy(): Promise<PasswordPolicy> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  try {
    const rows = (await db.execute(sql`
      SELECT value FROM system_settings WHERE key = 'password_policy'
    `)) as unknown as Array<{ value: unknown }>;
    const raw = rows[0]?.value;
    // The JSON column stores either the object directly (when the writer
    // hands the driver an object) or a JSON-string when the writer
    // pre-stringifies. system-settings.routes.ts uses the latter, so
    // peel the string when present.
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    const value = normalizePolicy(parsed);
    cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  } catch {
    return DEFAULT_POLICY;
  }
}

// ─── Generation ─────────────────────────────────────────────────────────

/**
 * Returns an unbiased random integer in [0, max). Uses rejection sampling
 * over a uniform 32-bit window so we don't get the modulo-bias of the
 * shorter `byte % alphabet.length` form for non-power-of-two alphabets
 * (the legacy generator had a tiny bias toward the first few letters).
 */
function randomInt(max: number): number {
  if (max <= 0) return 0;
  const limit = Math.floor(0x100000000 / max) * max;
  while (true) {
    const b = randomBytes(4);
    const n = (b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!;
    const u = n >>> 0;
    if (u < limit) return u % max;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function pickFromAlphabet(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

function generateAlphanumeric(policy: AlphanumericPolicy): string {
  return pickFromAlphabet(DEFAULT_ALPHABET, policy.length);
}

function capitalize(word: string): string {
  return word.length === 0 ? '' : word[0]!.toUpperCase() + word.slice(1);
}

function generatePassphrase(policy: PassphrasePolicy): string {
  const words: string[] = [];
  for (let i = 0; i < policy.word_count; i++) {
    const w = PASSPHRASE_WORDS[randomInt(PASSPHRASE_WORDS.length)]!;
    words.push(policy.capitalize_words ? capitalize(w) : w);
  }
  let out = words.join(policy.separator);
  if (policy.digit_count > 0) {
    const digits = pickFromAlphabet('0123456789', policy.digit_count);
    out += policy.separator.length > 0 ? policy.separator : '';
    out += digits;
  }
  if (policy.append_symbol) {
    out += SYMBOL_SET[randomInt(SYMBOL_SET.length)];
  }
  return out;
}

/**
 * Generate a password according to a specific policy. Used by the
 * preview endpoint and by tests; production callers should use
 * `generatePassword()` which reads the live system policy.
 */
export function generatePasswordFromPolicy(policy: PasswordPolicy): string {
  return policy.mode === 'passphrase'
    ? generatePassphrase(policy.passphrase)
    : generateAlphanumeric(policy.alphanumeric);
}

/**
 * Generate a password using the platform's currently-configured policy.
 * This is the canonical entry point for every server-side password mint.
 */
export async function generatePassword(): Promise<string> {
  const policy = await getPasswordPolicy();
  return generatePasswordFromPolicy(policy);
}
