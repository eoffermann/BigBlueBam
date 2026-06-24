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

export interface BinAvScanJobData {
  /** Scan a single asset immediately instead of sweeping. */
  asset_id?: string;
  /** Max assets per sweep. Defaults to 50. */
  limit?: number;
}

type ScanVerdict = 'clean' | 'infected' | 'skipped' | 'error';

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
  env: Env,
  logger: Logger,
): Promise<ScanVerdict> {
  if (env.BIN_AV_SCAN_MODE === 'off') return 'skipped';

  const body = await getObjectBuffer(asset.object_key);
  if (!body) {
    logger.warn({ assetId: asset.id, key: asset.object_key }, 'bin-av-scan: object not readable');
    return 'error';
  }

  if (env.BIN_AV_SCAN_MODE === 'clamav') {
    const host = env.CLAMAV_HOST;
    if (!host) {
      logger.error({ assetId: asset.id }, 'bin-av-scan: clamav mode but CLAMAV_HOST unset');
      return 'error';
    }
    return clamavScan(host, env.CLAMAV_PORT, body);
  }

  // eicar (default): dependency-free signature scan.
  return body.includes(EICAR_SIGNATURE) ? 'infected' : 'clean';
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

  logger.info({ jobId: job.id, candidates: pending.length, mode: env.BIN_AV_SCAN_MODE }, 'bin-av-scan: sweep start');

  let clean = 0;
  let infected = 0;
  let errored = 0;
  for (const asset of pending) {
    let verdict: ScanVerdict;
    try {
      verdict = await scanAsset(asset, env, logger);
    } catch (err) {
      verdict = 'error';
      logger.error(
        { assetId: asset.id, err: err instanceof Error ? err.message : String(err) },
        'bin-av-scan: scan threw',
      );
    }
    // Only advance rows still pending (a new version may have re-set it).
    await db.execute(sql`
      UPDATE bin_assets SET scan_status = ${verdict}
      WHERE id = ${asset.id} AND scan_status = 'pending'
    `);
    if (verdict === 'infected') infected += 1;
    else if (verdict === 'error') errored += 1;
    else clean += 1;
  }

  logger.info(
    { jobId: job.id, candidates: pending.length, clean, infected, errored },
    'bin-av-scan: sweep complete',
  );
}
