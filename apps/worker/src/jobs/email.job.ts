import nodemailer from 'nodemailer';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Env } from '../env.js';
import { getDb } from '../utils/db.js';
import { getSmtpConfig, type ResolvedSmtpConfig } from '../utils/smtp-config.js';

export interface EmailJobData {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// Cached transport keyed by a fingerprint of the resolved config. When the
// operator updates SMTP settings in the UI, the resolver cache (30s TTL)
// drops first, then the next call produces a new fingerprint and we build
// a fresh transport. Old transports are gc'd naturally.
let cachedTransport: nodemailer.Transporter | null = null;
let cachedFingerprint: string | null = null;

function fingerprintConfig(cfg: ResolvedSmtpConfig): string {
  return [cfg.host, cfg.port, cfg.user ?? '', cfg.pass ?? '', cfg.secure].join('|');
}

async function resolveTransport(env: Env): Promise<nodemailer.Transporter | null> {
  const cfg = await getSmtpConfig(getDb(), env);
  if (!cfg) return null;
  const fp = fingerprintConfig(cfg);
  if (cachedTransport && fp === cachedFingerprint) return cachedTransport;
  cachedTransport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  cachedFingerprint = fp;
  return cachedTransport;
}

export async function processEmailJob(
  job: Job<EmailJobData>,
  env: Env,
  logger: Logger,
): Promise<void> {
  const { to, subject, html, text } = job.data;

  logger.info({ jobId: job.id, to, subject }, 'Processing email job');

  const cfg = await getSmtpConfig(getDb(), env);
  const transport = await resolveTransport(env);

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
