// Run one probe function through runInOrgScopeRead (spec 3.1). Params are bound as TEXT and cast
// to jsonb: postgres.js would otherwise JSON-encode a string a second time and the function would
// receive a jsonb string, so every params lookup would silently read its default (M2 hazard).

import { bastionProbeFunctionName, bastionProbeResultSchema, type BastionProbeResult } from '@bigbluebam/shared';
import type { RunInOrgScopeRead } from '../engine/read-scope.js';
import type { ProbeDefinition } from './definitions.js';

export interface ProbeRunOk {
  ok: true;
  result: BastionProbeResult;
  replica_lag_ms: number;
}

export interface ProbeRunError {
  ok: false;
  /** Always an infrastructure failure: it never drifts a control (spec 3.2). */
  error: string;
  sqlstate: string | null;
}

/** Strip the people-facing population bookkeeping the SQL never reads. */
export function sqlParams(params: Record<string, unknown>): Record<string, unknown> {
  const { population_labels: _labels, population_confirmed_by: _by, ...rest } = params;
  return rest;
}

export async function runProbe(
  runRead: RunInOrgScopeRead,
  def: ProbeDefinition,
  orgId: string,
  asOf: Date,
  params: Record<string, unknown>,
): Promise<ProbeRunOk | ProbeRunError> {
  const fn = bastionProbeFunctionName(def.key, def.version);
  if (!/^bastion_probe_[a-z_]+_v\d+$/.test(fn)) return { ok: false, error: `bad probe function name ${fn}`, sqlstate: null };
  try {
    const { value, replica_lag_ms } = await runRead(orgId, asOf, async (tx) => {
      const rows = await tx.unsafe(`SELECT ${fn}($1::uuid, $2::timestamptz, $3::text::jsonb) AS r`, [
        orgId,
        asOf.toISOString(),
        JSON.stringify(sqlParams(params)),
      ]);
      return rows[0]?.r as unknown;
    });
    const parsed = bastionProbeResultSchema.safeParse(value);
    if (!parsed.success) {
      return { ok: false, error: `probe ${def.key} returned an unexpected shape: ${parsed.error.errors[0]?.message ?? ''}`, sqlstate: null };
    }
    return { ok: true, result: parsed.data, replica_lag_ms };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ok: false, error: e.message ?? String(err), sqlstate: typeof e.code === 'string' ? e.code : null };
  }
}

/** query_fingerprint: SHA-256 of pg_get_functiondef for the probe function (spec 3.1). */
export const FINGERPRINT_SQL = `
  SELECT p.proname AS name, encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS fingerprint
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE 'bastion\\_probe\\_%\\_v%'`;
