// What every engine needs, passed explicitly so the DB-backed tests can drive the real engine
// code with their own pools, a fake bucket and a fake clock. Engines speak raw SQL through
// postgres.js (they are SQL-shaped); every org-scoped transaction binds app.current_org_id.

import type postgres from 'postgres';
import type { StorageDriver } from '@bigbluebam/storage';
import type { RunInOrgScopeRead } from './read-scope.js';
import type { SealSigner } from '../lib/ledger-canonical.js';

/**
 * A transaction handle. postgres.js's TransactionSql type is an Omit<> of Sql that loses the
 * tagged-template call signature under this TypeScript setup, so engines type the handle as Sql
 * (same runtime object) and the cast lives only at the begin() boundary.
 */
export type Tx = postgres.Sql;

export interface EngineLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Small key/value store for cursors (ledger-verify, gap-rank). Redis in production. */
export interface CursorStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /**
   * Set `next` only while the stored value is still `expected` (null = absent); true when set.
   * Atomic (a Lua script in Redis), so a stale call can never move a cursor another call owns (#256).
   */
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
}

export interface EngineDeps {
  sql: postgres.Sql;
  runRead: RunInOrgScopeRead;
  storage: StorageDriver | null;
  log: EngineLog;
  now: () => Date;
  signer: SealSigner;
  /** Published seal public keys by signing_key_id (current plus retired); bucket seals must verify. */
  sealKeys: Map<string, string>;
  pdKeyId: string;
  /** HMAC commitment over a holder's personal data (spec 3.4). The key never leaves bastion-api. */
  pdHmac: (data: unknown) => string;
  probeTimeoutMs: number;
  putTimeoutMs: number;
  leaseMs: number;
  cursors: CursorStore;
  /** Process-wide cache of bucket seal identities, keyed by org (spec 3.4). */
  sealCache: Map<string, import('./restore.js').SealCacheEntry>;
}

/** Run `fn` in a transaction bound to one org (RLS GUC set LOCAL). */
export async function orgTx<T>(sql: postgres.Sql, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!orgId) throw new Error('orgTx called with no organization id');
  return (await sql.begin(async (raw) => {
    const tx = raw as unknown as Tx;
    await tx`SELECT set_config('app.current_org_id', ${orgId}, true)`;
    return fn(tx);
  })) as T;
}

export function sqlstateOf(err: unknown): string | null {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  if (typeof e?.code === 'string') return e.code;
  if (typeof e?.cause?.code === 'string') return e.cause.code;
  return null;
}

/** SQLSTATEs that say "try again", not "this statement can never succeed" (#295). */
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57014', // query_canceled (statement timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);
/** postgres.js and socket error codes for a connection that went away under the statement. */
const TRANSIENT_CONNECTION_CODES = new Set([
  'CONNECTION_ENDED',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
]);

/**
 * A database error that says nothing about the work itself (#295): a deadlock, a serialization
 * failure, a statement or lock timeout, a server restart, or a connection that was reset (class
 * 08, or the driver's own connection codes). Callers release and retry these instead of treating
 * them as a deterministic failure of whatever they were doing.
 */
export function isTransientDbError(err: unknown): boolean {
  const code = sqlstateOf(err);
  if (!code) return false;
  return TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || TRANSIENT_CONNECTION_CODES.has(code);
}

/** UTC calendar date (YYYY-MM-DD). */
export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The local date and minutes-since-midnight of an instant in an IANA zone (UTC on a bad zone). */
export function localClock(d: Date, timeZone: string): { date: string; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
  } catch {
    return localClock(d, 'UTC');
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}
