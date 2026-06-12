/**
 * turn-cert-expiry — daily watchdog for the TURN-TLS certificate.
 *
 * On Railway, TURN-TLS is the ONLY media path for calls (no public
 * UDP), and browsers VALIDATE the TURN certificate — an expired cert
 * doesn't degrade calling, it kills it, silently, with nothing in any
 * server log. The cert also can't auto-renew in place: it's delivered
 * to the livekit container as env-var PEMs (Railway has no volumes),
 * so renewal is a deliberate operator action.
 *
 * Per the no-shortcuts logging doctrine, this job makes the deadline
 * loud and actionable instead: once a day it TLS-connects to the TURN
 * endpoint, reads the certificate, and writes a system_errors row when
 * expiry is within 14 days (LIVEKIT_TURN_CERT_EXPIRING) or the
 * endpoint can't complete a TLS handshake at all
 * (LIVEKIT_TURN_UNREACHABLE). Rows are deduped so a standing condition
 * reports once per distinct state, not once per day.
 *
 * Configuration: LIVEKIT_TURN_CHECK_TARGET="host:port" on the worker
 * (e.g. "turn.bigbluebam.com:34567"). Unset = deployment has no TURN
 * (compose LAN stacks) and the job no-ops.
 */
import tls from 'node:tls';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { getDb } from '../utils/db.js';

export interface TurnCertExpiryJobData {
  /** Test override for the "host:port" target. */
  target?: string;
}

const WARN_WINDOW_DAYS = 14;

export interface TurnCertProbe {
  ok: boolean;
  /** Days until expiry (may be negative when already expired). */
  daysLeft?: number;
  serial?: string;
  validTo?: string;
  error?: string;
}

/** TLS-connect and read the peer certificate. Injectable for tests. */
export function probeTurnCert(host: string, port: number, timeoutMs = 5000): Promise<TurnCertProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: TurnCertProbe) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    const socket = tls.connect(
      {
        host,
        port,
        servername: host,
        timeout: timeoutMs,
        // We're reading expiry, not establishing trust — accept whatever
        // chain the server presents so we can warn about an INVALID cert
        // (browsers will reject it; we still want to see why).
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) {
          done({ ok: false, error: 'no peer certificate presented' });
          return;
        }
        const validTo = new Date(cert.valid_to);
        const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
        done({
          ok: true,
          daysLeft,
          serial: cert.serialNumber ?? 'unknown',
          validTo: validTo.toISOString(),
        });
      },
    );
    socket.on('error', (err) => done({ ok: false, error: err.message }));
    socket.on('timeout', () => done({ ok: false, error: 'TLS connect timeout' }));
  });
}

export async function processTurnCertExpiryJob(
  job: Job<TurnCertExpiryJobData>,
  logger: Logger,
  probe: typeof probeTurnCert = probeTurnCert,
): Promise<void> {
  const target = job.data?.target ?? process.env.LIVEKIT_TURN_CHECK_TARGET ?? '';
  if (!target) {
    logger.debug('turn-cert-expiry: LIVEKIT_TURN_CHECK_TARGET unset, skipping (no TURN on this deployment)');
    return;
  }
  const m = /^(.+):(\d{2,5})$/.exec(target.trim());
  if (!m) {
    logger.warn({ target }, 'turn-cert-expiry: malformed target (want host:port), skipping');
    return;
  }
  const host = m[1]!;
  const port = Number(m[2]!);

  const result = await probe(host, port);
  const db = getDb();

  const dedupeKey = result.ok
    ? `expiring:${result.serial}:${result.daysLeft}`
    : `unreachable:${result.error}`;

  if (result.ok && (result.daysLeft ?? 0) > WARN_WINDOW_DAYS) {
    logger.info(
      { target, daysLeft: result.daysLeft, validTo: result.validTo },
      'turn-cert-expiry: certificate healthy',
    );
    return;
  }

  const code = result.ok ? 'LIVEKIT_TURN_CERT_EXPIRING' : 'LIVEKIT_TURN_UNREACHABLE';

  // Dedupe: one row per distinct condition state.
  const lastRows = (await db.execute(sql`
    SELECT payload
    FROM system_errors
    WHERE error_code = ${code}
    ORDER BY created_at DESC
    LIMIT 1
  `)) as unknown as Array<{ payload: { dedupe_key?: string } }>;
  if (lastRows[0]?.payload?.dedupe_key === dedupeKey) {
    logger.info({ target, code }, 'turn-cert-expiry: condition persists, already reported');
    return;
  }

  const message = result.ok
    ? `The TURN-TLS certificate for ${target} expires in ${result.daysLeft} day(s) (${result.validTo}). ` +
      `TURN is the only media path for calls on Railway — when this cert expires, calling STOPS. ` +
      `Renew the certificate for ${host} and update LIVEKIT_TURN_CERT_PEM / LIVEKIT_TURN_KEY_PEM on the Railway livekit service ` +
      `(see docs/livekit-networking-notes.md, "TURN on Railway").`
    : `The TURN-TLS endpoint ${target} did not complete a TLS handshake (${result.error}). ` +
      `If this persists, calls on this deployment cannot establish media. ` +
      `Check the Railway livekit service, its TCP proxy, and DNS for ${host} (see docs/livekit-networking-notes.md).`;

  await db.execute(sql`
    INSERT INTO system_errors (service, error_code, message, payload)
    VALUES (
      'worker',
      ${code},
      ${message},
      ${JSON.stringify({
        target,
        days_left: result.daysLeft ?? null,
        valid_to: result.validTo ?? null,
        serial: result.serial ?? null,
        probe_error: result.error ?? null,
        dedupe_key: dedupeKey,
        queue: 'turn-cert-expiry',
        job_id: job.id ?? null,
      })}::jsonb
    )
  `);

  logger.warn({ target, code, daysLeft: result.daysLeft }, 'turn-cert-expiry: reported to system_errors');
}
