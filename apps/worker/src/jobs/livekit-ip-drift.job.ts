/**
 * livekit-ip-drift — hourly watchdog for stale LiveKit address
 * advertisement.
 *
 * The livekit-config init service renders LiveKit's advertised
 * addresses at every `docker compose up`, but nothing re-renders while
 * the stack just keeps running — and home/small-office WAN IPs rotate.
 * A rotated WAN IP means LiveKit advertises an address that is no
 * longer ours: remote callers start failing with BUREAU_CONNECT_FAILED
 * while everything else looks healthy.
 *
 * The worker can't fix this itself (it has no Docker control, by
 * design), so per the no-shortcuts logging policy it makes the
 * condition loud and actionable instead: re-detect the public IP via
 * STUN each hour, compare to what livekit-config recorded in
 * advertised.json (read-only mount at /livekit-info), and write a
 * LIVEKIT_WAN_IP_DRIFT row to system_errors with the exact remediation
 * command. Deduped per (advertised, current) pair so a persistent
 * drift produces one row, not one per hour.
 */
import fs from 'node:fs';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { detectWanIpViaStun, isValidIpv4 } from '../utils/stun.js';

export interface LivekitIpDriftJobData {
  /** Test override for the advertised.json location. */
  advertised_path?: string;
}

interface AdvertisedState {
  lan?: string | null;
  wan?: string | null;
  rendered_at?: string;
}

const DEFAULT_ADVERTISED_PATH = '/livekit-info/advertised.json';

export async function processLivekitIpDriftJob(
  job: Job<LivekitIpDriftJobData>,
  logger: Logger,
  // Injectable for tests; defaults to the real STUN detector.
  detectWan: () => Promise<string | null> = detectWanIpViaStun,
): Promise<void> {
  const advertisedPath = job.data?.advertised_path ?? DEFAULT_ADVERTISED_PATH;

  let advertised: AdvertisedState | null = null;
  try {
    advertised = JSON.parse(fs.readFileSync(advertisedPath, 'utf8')) as AdvertisedState;
  } catch {
    // No advertised.json: stack predates livekit-config or the mount is
    // missing. Nothing to compare against — not an error worth a row.
    logger.debug({ advertisedPath }, 'livekit-ip-drift: no advertised.json, skipping');
    return;
  }

  if (!advertised?.wan || !isValidIpv4(advertised.wan)) {
    // LAN-only / air-gapped deploy (LIVEKIT_EXTERNAL_IP=none) — there
    // is no public advertisement to go stale.
    logger.debug('livekit-ip-drift: no WAN advertised, skipping');
    return;
  }

  const current = await detectWan();
  if (!current) {
    // Transient: no STUN server reachable right now. Log locally; an
    // hour from now we try again. Writing a row here would conflate
    // "egress hiccup" with "address drift".
    logger.warn('livekit-ip-drift: WAN detection failed this cycle (no STUN response)');
    return;
  }

  if (current === advertised.wan) return; // healthy

  const db = getDb();

  // Dedupe: one row per distinct (advertised → current) transition.
  const lastRows = (await db.execute(sql`
    SELECT payload
    FROM system_errors
    WHERE error_code = 'LIVEKIT_WAN_IP_DRIFT'
    ORDER BY created_at DESC
    LIMIT 1
  `)) as unknown as Array<{ payload: { advertised_wan?: string; current_wan?: string } }>;
  const last = lastRows[0]?.payload;
  if (last?.advertised_wan === advertised.wan && last?.current_wan === current) {
    logger.info(
      { advertised: advertised.wan, current },
      'livekit-ip-drift: drift persists, already reported',
    );
    return;
  }

  const message =
    `LiveKit is advertising public IP ${advertised.wan} but this host's public IP is now ${current} — ` +
    `the address rotated after the last config render (${advertised.rendered_at ?? 'unknown time'}). ` +
    `Remote callers will fail to connect to calls until LiveKit re-renders. ` +
    `Fix: docker compose up -d --force-recreate livekit-config livekit ` +
    `(the livekit-config service re-detects the address and re-renders automatically).`;

  await db.execute(sql`
    INSERT INTO system_errors (service, error_code, message, payload)
    VALUES (
      'worker',
      'LIVEKIT_WAN_IP_DRIFT',
      ${message},
      ${JSON.stringify({
        advertised_wan: advertised.wan,
        current_wan: current,
        advertised_lan: advertised.lan ?? null,
        advertised_rendered_at: advertised.rendered_at ?? null,
        queue: 'livekit-ip-drift',
        job_id: job.id ?? null,
      })}::jsonb
    )
  `);

  logger.warn(
    { advertised: advertised.wan, current },
    'livekit-ip-drift: WAN IP drift detected and reported to system_errors',
  );
}
