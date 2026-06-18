import nodemailer from 'nodemailer';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Env } from '../env.js';
import { getDb } from '../utils/db.js';
import {
  getSmtpConfig,
  getSmtpConfigForOrg,
  type ResolvedSmtpConfig,
} from '../utils/smtp-config.js';

export interface EmailJobData {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Optional originating org. When set, the worker resolves the SMTP relay
   * org-first (org override → platform → env) so transactional mail an org
   * triggered (e.g. a member invitation) rides that org's own relay if it
   * configured one. Platform-level mail with no org context (system alerts,
   * the first-org bootstrap invite) omits this and uses the platform relay.
   */
  org_id?: string;
}

// Cached transports keyed by a fingerprint of the resolved config. When the
// operator updates SMTP settings in the UI, the resolver cache (30s TTL)
// drops first, then the next call produces a new fingerprint and we build
// a fresh transport. Old transports are gc'd naturally. We keep one slot
// per fingerprint so different orgs' relays don't thrash a single slot.
const transportCache = new Map<string, nodemailer.Transporter>();

function fingerprintConfig(cfg: ResolvedSmtpConfig): string {
  return [cfg.host, cfg.port, cfg.user ?? '', cfg.pass ?? '', cfg.secure].join('|');
}

function transportFor(cfg: ResolvedSmtpConfig): nodemailer.Transporter {
  const fp = fingerprintConfig(cfg);
  const existing = transportCache.get(fp);
  if (existing) return existing;
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  transportCache.set(fp, transport);
  return transport;
}

export async function processEmailJob(
  job: Job<EmailJobData>,
  env: Env,
  logger: Logger,
): Promise<void> {
  const { to, subject, html, text, org_id } = job.data;

  logger.info({ jobId: job.id, to, subject, org_id }, 'Processing email job');

  // Org-scoped jobs resolve org → platform → env; platform-level jobs use
  // the platform → env resolver. Both share the same env fallback.
  const cfg = org_id
    ? await getSmtpConfigForOrg(getDb(), org_id, env)
    : await getSmtpConfig(getDb(), env);
  const transport = cfg ? transportFor(cfg) : null;

  if (!transport || !cfg) {
    logger.warn(
      { to, subject, html: html.substring(0, 200), text: text?.substring(0, 200) },
      'SMTP not configured (neither system_settings nor env vars) — logging email instead of sending',
    );
    return;
  }

  try {
    const info = await transport.sendMail({
      from: cfg.from,
      to,
      subject,
      html,
      text: text ?? undefined,
    });
    logger.info({ jobId: job.id, messageId: info.messageId }, 'Email sent successfully');
  } catch (err) {
    // Attach the resolved SMTP context so the SuperUser Log Analysis
    // tab can show "tried to send via foo:465 (TLS on)" instead of
    // making the operator guess which config the failure came from.
    (err as Error & { smtp_context?: unknown }).smtp_context = {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      source: cfg.source,
    };
    throw err;
  }
}
