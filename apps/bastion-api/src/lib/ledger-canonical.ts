// The ledger's canonical form (spec 3.4), shared by the writer and every verifier. Nothing in
// here touches a database, a bucket or the environment, so goldens and tamper tests run alone.
//
//   entry_hash = hex_lower(sha256(canonical_json({
//     org, epoch, seq, kind, id, content_sha256, personal_data_hmac, pd_hmac_key_id, prev, recorded_at
//   })))
//
// canonical_json: object keys sorted, no whitespace, integers as JSON integers, `undefined`
// never appears (callers pass null). recorded_at is set in the application, truncated to
// milliseconds, as UTC ISO with `Z`. prev is lowercase hex; the genesis prev is 64 zeros.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { BASTION_LEDGER_GENESIS_HASH } from '@bigbluebam/shared';

export const GENESIS_HASH = BASTION_LEDGER_GENESIS_HASH;

/** Deterministic JSON: sorted keys, no whitespace. Rejects values JSON cannot round-trip. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Millisecond-truncated UTC ISO with Z (what the ledger stores and hashes). */
export function toRecordedAt(d: Date): string {
  return new Date(Math.floor(d.getTime())).toISOString();
}

export interface LedgerEntryFields {
  org: string;
  epoch: number;
  seq: number;
  kind: string;
  id: string;
  content_sha256: string | null;
  personal_data_hmac: string | null;
  pd_hmac_key_id: string | null;
  prev: string;
  recorded_at: string;
}

export function entryHash(f: LedgerEntryFields): string {
  if (!Number.isSafeInteger(f.epoch) || !Number.isSafeInteger(f.seq)) {
    throw new Error('entryHash: epoch and seq must be integers');
  }
  return sha256Hex(
    canonicalJson({
      org: f.org,
      epoch: f.epoch,
      seq: f.seq,
      kind: f.kind,
      id: f.id,
      content_sha256: f.content_sha256,
      personal_data_hmac: f.personal_data_hmac,
      pd_hmac_key_id: f.pd_hmac_key_id,
      prev: f.prev.toLowerCase(),
      recorded_at: f.recorded_at,
    }),
  );
}

/** A ledger row as read back from Postgres (bigint seq may arrive as a string). */
export interface LedgerRow {
  organization_id: string;
  epoch: number | string;
  seq: number | string;
  entry_kind: string;
  entry_id: string;
  content_sha256: string | null;
  personal_data_hmac: string | null;
  pd_hmac_key_id: string | null;
  prev_entry_hash: string;
  entry_hash: string;
  recorded_at: Date | string;
}

export function fieldsOfRow(row: LedgerRow): LedgerEntryFields {
  return {
    org: row.organization_id,
    epoch: Number(row.epoch),
    seq: Number(row.seq),
    kind: row.entry_kind,
    id: row.entry_id,
    content_sha256: row.content_sha256,
    personal_data_hmac: row.personal_data_hmac,
    pd_hmac_key_id: row.pd_hmac_key_id,
    prev: row.prev_entry_hash,
    recorded_at: toRecordedAt(row.recorded_at instanceof Date ? row.recorded_at : new Date(row.recorded_at)),
  };
}

/** True when the stored hash is the hash of the stored fields. */
export function rowHashIntact(row: LedgerRow): boolean {
  return entryHash(fieldsOfRow(row)) === row.entry_hash;
}

export type ChainProblem =
  | { seq: number; problem: 'hash_mismatch' }
  | { seq: number; problem: 'prev_mismatch'; expected_prev: string };

/**
 * Walk consecutive rows (ordered by seq) and report every row whose hash does not match its
 * fields, or whose prev is not the previous row's hash. A seq gap is not a problem here: the
 * provisional-epoch rule skips sealed numbers on purpose (the restore rows explain the gap).
 */
export function verifyChain(rows: LedgerRow[], startPrev?: string): ChainProblem[] {
  const problems: ChainProblem[] = [];
  let prev = startPrev;
  for (const row of rows) {
    const seq = Number(row.seq);
    if (!rowHashIntact(row)) problems.push({ seq, problem: 'hash_mismatch' });
    if (prev !== undefined && row.prev_entry_hash !== prev) {
      problems.push({ seq, problem: 'prev_mismatch', expected_prev: prev });
    }
    prev = row.entry_hash;
  }
  return problems;
}

/** The prefix every chain-break notice marker shares (cleared together after a clean full pass). */
export const CHAIN_BREAK_MARKER_PREFIX = 'evidence.integrity_failed:chain:';

/**
 * The dedupe key for one chain break, keyed on the OBSERVED broken state (#297): the epoch, the
 * seq, the problem, and a digest of the row as found (its stored hash, the hash its fields give
 * now, its stored prev, and the prev the chain expected). An unrepaired break keeps its key and
 * alerts once; a fresh tamper of the same row (repaired, then changed again; or the same seq in a
 * later epoch) gives a new key and alerts again.
 */
export function chainBreakKey(row: LedgerRow, p: ChainProblem): string {
  let computed = '';
  try {
    computed = entryHash(fieldsOfRow(row));
  } catch {
    computed = 'unhashable';
  }
  const observed = [row.entry_hash, computed, row.prev_entry_hash ?? '', p.problem === 'prev_mismatch' ? p.expected_prev : ''].join('|');
  return `${CHAIN_BREAK_MARKER_PREFIX}${Number(row.epoch)}:${p.seq}:${p.problem}:${sha256Hex(observed).slice(0, 32)}`;
}

// ── Seals (Ed25519) ─────────────────────────────────────────────────────────────────────

/** The fields a seal signs. The same object is the body of `seals/<org>/<seal_date>.json`. */
export interface SealPayload {
  org: string;
  seal_date: string;
  epoch: number;
  head_seq: number;
  head_hash: string;
  signing_key_id: string;
}

// PKCS#8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
// SPKI DER prefix for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface SealSigner {
  keyId: string;
  publicKeyHex: string;
  privateKey: KeyObject;
}

/** The signing key id: a short, stable fingerprint of the raw public key. */
export function signingKeyIdOf(publicKeyHex: string): string {
  return `ed25519:${sha256Hex(Buffer.from(publicKeyHex, 'hex')).slice(0, 16)}`;
}

/** BASTION_SEAL_SIGNING_KEY is a 64-hex Ed25519 seed (spec 9.4). */
export function sealSignerFromSeed(seedHex: string): SealSigner {
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error('seal signing key must be 64 hex characters');
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKeyHex = spki.subarray(spki.length - 32).toString('hex');
  return { keyId: signingKeyIdOf(publicKeyHex), publicKeyHex, privateKey };
}

function publicKeyFromHex(publicKeyHex: string): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

/** Ed25519 over the canonical JSON of a payload that names its own signing key. */
function signCanonical(payload: { signing_key_id: string }, signer: SealSigner, what: string): string {
  if (payload.signing_key_id !== signer.keyId) throw new Error(`${what}: payload names a different key`);
  return edSign(null, Buffer.from(canonicalJson(payload)), signer.privateKey).toString('base64');
}

/** Verify against the published keys (current and retired), by the payload's own signing_key_id. */
function verifyCanonical(payload: { signing_key_id: string }, signatureB64: string, publicKeysById: Map<string, string>): boolean {
  const pub = publicKeysById.get(payload.signing_key_id);
  if (!pub) return false;
  try {
    return edVerify(null, Buffer.from(canonicalJson(payload)), publicKeyFromHex(pub), Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export function signSeal(payload: SealPayload, signer: SealSigner): string {
  return signCanonical(payload, signer, 'signSeal');
}

/**
 * Verify a seal against the published keys (current and retired), looked up by the seal's own
 * signing_key_id, so seals signed before a key change stay verifiable.
 */
export function verifySeal(payload: SealPayload, signatureB64: string, publicKeysById: Map<string, string>): boolean {
  return verifyCanonical(payload, signatureB64, publicKeysById);
}

// ── Restore records (#208) ──────────────────────────────────────────────────────────────

/**
 * The fields a restore record signs: the body of `restores/<org>/<id>.json`, which describes
 * history lost to a restore and survives a database rewind. Same key, key id and canonical form
 * as a seal; `record` names the kind, so a record's signature can never stand for a seal's (their
 * canonical bytes differ) and the other way round.
 */
export interface RestoreRecordPayload {
  record: 'ledger_restore';
  id: string;
  organization_id: string;
  detected_at: string;
  db_head_seq: number | null;
  bucket_seal_date: string | null;
  bucket_epoch: number | null;
  bucket_head_seq: number | null;
  bucket_head_hash: string | null;
  lost_from_seq: number | null;
  lost_to_seq: number | null;
  provisional_epoch: number;
  platform_restore_id: string | null;
  status: string;
  resolution: string | null;
  resolved_at: string | null;
  signing_key_id: string;
}

export function signRestoreRecord(payload: RestoreRecordPayload, signer: SealSigner): string {
  return signCanonical(payload, signer, 'signRestoreRecord');
}

export function verifyRestoreRecord(payload: RestoreRecordPayload, signatureB64: string, publicKeysById: Map<string, string>): boolean {
  return verifyCanonical(payload, signatureB64, publicKeysById);
}

/** Compare (epoch, seq) identities: negative when a < b. */
export function compareEpochSeq(a: { epoch: number; seq: number }, b: { epoch: number; seq: number }): number {
  return a.epoch !== b.epoch ? a.epoch - b.epoch : a.seq - b.seq;
}
