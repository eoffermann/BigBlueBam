/**
 * Bin AV-scan sweep (Bin master §9.3).
 *
 * Bin is the suite's first real virus scanner. On upload completion bin-api
 * inserts/advances an asset with `scan_status='pending'`; serving is gated until
 * a scan flips it to `clean` (or `skipped`). This job is that scanner.
 *
 * It runs as a sweep (mirrors blank-file-process): every minute it claims a
 * batch of `pending` assets, fetches the active version's bytes, scans them, and
 * writes the verdict back to `bin_assets.scan_status`. It can also be invoked
 * with `{ asset_id }` to scan one asset immediately.
 *
 * Scan modes (env `BIN_AV_SCAN_MODE`):
 *   - `eicar`  (default) — dependency-free signature scan. Flags the standard
 *                EICAR test string as `infected`, otherwise marks `clean`. Keeps
 *                the pipeline autonomous on a bare stack and makes both gates
 *                testable with synthetic data.
 *   - `clamav` — streams the object to a clamd INSTREAM endpoint
 *                (CLAMAV_HOST:CLAMAV_PORT). FOUND -> infected, OK -> clean.
 *   - `off`    — marks every object `skipped` (no inspection).
 *
 * Any fetch/scan failure marks the asset `error` so an operator notices; the
 * asset stays unservable (only clean/skipped are served).
 */

import net from 'node:net';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { Env } from '../env.js';
import { getDb } from '../utils/db.js';
import { getObjectBuffer } from '../utils/storage.js';
import { resolveAvConfig, type ResolvedAvConfig } from '../utils/av-config.js';

export interface BinAvScanJobData {
  /** Scan a single asset immediately instead of sweeping. */
  asset_id?: string;
  /** Max assets per sweep. Defaults to 50. */
  limit?: number;
}

type ScanVerdict = 'clean' | 'infected' | 'skipped' | 'error';

/** A scan result plus, when the verdict is 'error', a machine code + human
 *  message so the sweep can record a SuperUser-visible system_errors row. */
interface ScanResult {
  verdict: ScanVerdict;
  errorCode?: string;
  message?: string;
}

interface PendingAssetRow {
  id: string;
  object_key: string;
}

// The EICAR anti-virus test file — a harmless 68-byte string every scanner is
// required to detect. Split so this source file is not itself flagged.
const EICAR_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}' + '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** Stream a buffer to clamd via the INSTREAM protocol. Resolves to a verdict. */
function clamavScan(host: string, port: number, body: Buffer): Promise<ScanVerdict> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let response = '';
    let settled = false;
    const done = (v: ScanVerdict) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(30_000);
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      // Chunk the payload as [4-byte BE length][bytes], then a zero-length
      // terminator. 64KB chunks stay well under clamd's StreamMaxLength tuning.
      const CHUNK = 64 * 1024;
      for (let off = 0; off < body.length; off += CHUNK) {
        const slice = body.subarray(off, Math.min(off + CHUNK, body.length));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(slice.length, 0);
        socket.write(header);
        socket.write(slice);
      }
      const terminator = Buffer.alloc(4);
      terminator.writeUInt32BE(0, 0);
      socket.write(terminator);
    });
    socket.on('data', (d) => {
      response += d.toString('utf8');
    });
    socket.on('end', () => {
      // "stream: OK" => clean; "... FOUND" => infected; anything else => error.
      if (/\bOK\b/.test(response) && !/FOUND/.test(response)) return done('clean');
      if (/FOUND/.test(response)) return done('infected');
      done('error');
    });
    socket.on('timeout', () => done('error'));
    socket.on('error', () => done('error'));
  });
}

async function scanAsset(
  asset: PendingAssetRow,
  cfg: ResolvedAvConfig,
  logger: Logger,
): Promise<ScanResult> {
  if (cfg.mode === 'off') return { verdict: 'skipped' };

  const body = await getObjectBuffer(asset.object_key);
  if (!body) {
    logger.warn({ assetId: asset.id, key: asset.object_key }, 'bin-av-scan: object not readable');
    return {
      verdict: 'error',
      errorCode: 'AV_OBJECT_UNREADABLE',
      message: `Object not readable from storage: ${asset.object_key}`,
    };
  }

  if (cfg.mode === 'clamav') {
    const host = cfg.clamavHost;
    if (!host) {
      logger.error({ assetId: asset.id }, 'bin-av-scan: clamav mode but CLAMAV_HOST unset');
      return {
        verdict: 'error',
        errorCode: 'AV_CONFIG_MISSING',
        message: 'clamav scan mode is selected but no clamav host is configured',
      };
    }
    const verdict = await clamavScan(host, cfg.clamavPort, body);
    if (verdict === 'error') {
      return {
        verdict: 'error',
        errorCode: 'AV_CLAMAV_UNREACHABLE',
        message: `clamd at ${host}:${cfg.clamavPort} did not return a usable verdict (connection/timeout)`,
      };
    }
    return { verdict };
  }

  // eicar (default): dependency-free signature scan.
  return { verdict: body.includes(EICAR_SIGNATURE) ? 'infected' : 'clean' };
}

/**
 * Record a per-asset scan failure in system_errors so the SuperUser Log
 * Analysis tab surfaces it (the whole-job 'failed' listener only fires on a
 * thrown job, not a per-asset verdict='error'). Best-effort; never throws.
 * Column shape mirrors apps/worker/src/utils/record-error.ts.
 */
async function recordAvError(
  db: ReturnType<typeof getDb>,
  opts: { assetId: string; objectKey: string; mode: string; errorCode: string; message: string },
): Promise<void> {
  try {
    const payload = { asset_id: opts.assetId, object_key: opts.objectKey, mode: opts.mode };
    await db.execute(sql`
      INSERT INTO system_errors (
        service, request_id, method, route, status_code,
        error_code, message, stack, payload
      ) VALUES (
        'worker', NULL, NULL, 'bin-av-scan', NULL,
        ${opts.errorCode}, ${opts.message.slice(0, 4000)}, NULL,
        ${JSON.stringify(payload)}::jsonb
      )
    `);
  } catch {
    /* swallow — a recorder that throws must not compound the scan failure */
  }
}

export async function processBinAvScanJob(
  job: Job<BinAvScanJobData>,
  env: Env,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const { asset_id, limit } = job.data ?? {};
  const cap = limit ?? 50;

  const raw = asset_id
    ? await db.execute(sql`
        SELECT id, object_key FROM bin_assets
        WHERE id = ${asset_id} AND scan_status = 'pending' AND object_key <> ''
        LIMIT 1
      `)
    : await db.execute(sql`
        SELECT id, object_key FROM bin_assets
        WHERE scan_status = 'pending' AND object_key <> ''
        ORDER BY created_at ASC
        LIMIT ${cap}
      `);

  const pending = rows<PendingAssetRow>(raw);
  if (pending.length === 0) {
    logger.debug('bin-av-scan: no pending assets');
    return;
  }

  const cfg = await resolveAvConfig(env);

  logger.info({ jobId: job.id, candidates: pending.length, mode: cfg.mode }, 'bin-av-scan: sweep start');

  let clean = 0;
  let infected = 0;
  let errored = 0;
  for (const asset of pending) {
    let result: ScanResult;
    try {
      result = await scanAsset(asset, cfg, logger);
    } catch (err) {
      result = {
        verdict: 'error',
        errorCode: 'AV_SCAN_THREW',
        message: err instanceof Error ? err.message : String(err),
      };
      logger.error(
        { assetId: asset.id, err: err instanceof Error ? err.message : String(err) },
        'bin-av-scan: scan threw',
      );
    }
    const verdict = result.verdict;
    // Only advance rows still pending (a new version may have re-set it).
    await db.execute(sql`
      UPDATE bin_assets SET scan_status = ${verdict}
      WHERE id = ${asset.id} AND scan_status = 'pending'
    `);
    if (verdict === 'infected') infected += 1;
    else if (verdict === 'error') {
      errored += 1;
      await recordAvError(db, {
        assetId: asset.id,
        objectKey: asset.object_key,
        mode: cfg.mode,
        errorCode: result.errorCode ?? 'AV_SCAN_ERROR',
        message: result.message ?? 'AV scan failed',
      });
    } else clean += 1;
  }

  logger.info(
    { jobId: job.id, candidates: pending.length, clean, infected, errored },
    'bin-av-scan: sweep complete',
  );
}
