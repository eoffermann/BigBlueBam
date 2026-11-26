// What the M5 evidence services need beyond the engine deps: Bin's bucket (read-only), the Bin
// access checks, and the two producers (control-scope runs and the evidence-ingest retry). Passed
// explicitly so the DB-backed tests drive the real service code with fakes.

import type { StorageDriver } from '@bigbluebam/storage';
import type { EngineDeps, Tx } from '../engine/context.js';
import type { QueuedRun } from '../engine/evidence-store.js';
import type { BinAccessDeps } from '../lib/bin-asset-access.js';

export interface EvidenceDeps {
  engine: EngineDeps;
  /** The shared uploads bucket Bin writes to; read-only here. */
  binStorage: StorageDriver | null;
  /** Bin lookups bound to a transaction, plus the can_access preflight. */
  bin: (tx: Tx) => BinAccessDeps;
  enqueueRuns: (runs: QueuedRun[]) => Promise<void>;
  /** Ask the worker to retry a pending scan soon (best effort; the 10-minute sweep is the floor). */
  enqueueIngest: (orgId: string, manualEvidenceId: string) => Promise<void>;
  /** The org has fewer than three humans: a self-review is allowed and labelled (spec 3.3). */
  smallTeamThreshold?: number;
}

/** Bin rows read through a Bastion transaction (cross-app read, no FK, no org predicate). */
export function binLookups(tx: Tx, canAccess: BinAccessDeps['canAccess']): BinAccessDeps {
  return {
    async loadAsset(assetId) {
      const rows = await tx`SELECT id, org_id, scan_status, current_version_id FROM bin_assets WHERE id = ${assetId} LIMIT 1`;
      const r = rows[0];
      return r
        ? { id: String(r.id), org_id: String(r.org_id), scan_status: String(r.scan_status), current_version_id: (r.current_version_id as string | null) ?? null }
        : null;
    },
    async loadVersion(versionId) {
      const rows = await tx`SELECT id, asset_id, object_key, size, content_type FROM bin_asset_versions WHERE id = ${versionId} LIMIT 1`;
      const r = rows[0];
      return r
        ? { id: String(r.id), asset_id: String(r.asset_id), object_key: String(r.object_key), size: Number(r.size), content_type: String(r.content_type) }
        : null;
    },
    canAccess,
  };
}
