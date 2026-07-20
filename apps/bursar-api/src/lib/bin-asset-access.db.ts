// Production dependency factories for the §5.8 Bin asset access gate.
//
// Kept OUT of bin-asset-access.ts so that pure module stays loadable by the unit test without
// booting env (loadEnv process.exits when the service env vars are absent). Everything here
// touches db / env / the shared visibility client and is used only by the request service.

import { sql } from 'drizzle-orm';
import { preflightAccess } from '@bigbluebam/shared/visibility-client';
import type { DbTx } from '../db/index.js';
import { env } from '../env.js';
import type { AccessChecker, BinAssetAccessDeps, BinAssetLoader } from './bin-asset-access.js';

/** Real asset loader against the shared DB (cross-app dotted read, no cross-schema FK). No org
 *  predicate, so a cross-org row is returned and then rejected on the org-equality check. */
export function makeDbAssetLoader(tx: DbTx): BinAssetLoader {
  return async (assetId: string) => {
    const rows = (await tx.execute(
      sql`SELECT id, org_id, scan_status, current_version_id FROM bin_assets WHERE id = ${assetId} LIMIT 1`,
    )) as unknown as Array<{
      id: string;
      org_id: string;
      scan_status: string;
      current_version_id: string | null;
    }>;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      org_id: row.org_id,
      scan_status: row.scan_status,
      current_version_id: row.current_version_id,
    };
  };
}

/** Real can_access checker via the shared visibility-client (fail-closed). */
export const dbAccessChecker: AccessChecker = (askerUserId, entityType, entityId) =>
  preflightAccess(askerUserId, entityType, entityId, {
    apiInternalUrl: env.BBB_API_INTERNAL_URL,
    internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
    timeoutMs: env.UPSTREAM_TIMEOUT_MS,
  });

/** Assemble the production deps for a given transaction. */
export function makeBinAssetAccessDeps(tx: DbTx): BinAssetAccessDeps {
  return { loadAsset: makeDbAssetLoader(tx), canAccess: dbAccessChecker };
}
