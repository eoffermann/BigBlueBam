/**
 * Blank form submission confirmation/notification email job
 * (Blank_Plan.md G2).
 *
 * Triggered by the Blank API after `createSubmission()` inserts a row.
 * In practice the Blank API does not yet push to a BullMQ queue, so this
 * worker ALSO runs in sweep mode every few minutes: it scans for
 * submissions where `processed = false` and the parent form has
 * `notify_on_submit = true` (or a non-empty `notify_emails` array), sends
 * the confirmation email to the submitter and the notification email to
 * each `notify_emails` address, and flips `processed = true` as the
 * idempotency marker.
 *
 * Emits `submission.confirmation_sent` with source `'blank'` once the
 * emails have been dispatched (or logged, if SMTP is not configured).
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type Redis from 'ioredis';
import { sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';
import { getSmtpConfig } from '../utils/smtp-config.js';
import { postBanterChannelMessage } from '../utils/banter-post.js';
import type { Env } from '../env.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface BlankConfirmationEmailJobData {
  /** Direct mode: process a single submission by id. */
  submission_id?: string;
  /** Sweep mode tick payload: leave empty. */
  sweep?: boolean;
  /** Row cap per sweep. Defaults to 50. */
  limit?: number;
}

interface SubmissionRow {
  id: string;
  form_id: string;
  organization_id: string;
  submitted_by_email: string | null;
  submitted_at: Date;
  processed: boolean;
  form_name: string;
  form_slug: string;
  confirmation_type: string | null;
  confirmation_message: string | null;
  notify_on_submit: boolean;
  notify_emails: string[] | null;
  notify_banter_channel_id: string | null;
}

async function loadSubmissionById(submissionId: string): Promise<SubmissionRow | null> {
  const db = getDb();
  const rowsRaw = await db.execute(sql`
    SELECT
      s.id,
      s.form_id,
      s.organization_id,
      s.submitted_by_email,
      s.submitted_at,
      s.processed,
      f.name AS form_name,
      f.slug AS form_slug,
      f.confirmation_type,
      f.confirmation_message,
      f.notify_on_submit,
      f.notify_emails,
      f.notify_banter_channel_id
    FROM blank_submissions s
    INNER JOIN blank_forms f ON f.id = s.form_id
    WHERE s.id = ${submissionId}
    LIMIT 1
  `);
  const rows = Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? []);
  return (rows[0] as SubmissionRow) ?? null;
}

async function findPendingSubmissions(limit: number): Promise<SubmissionRow[]> {
  const db = getDb();
  const rowsRaw = await db.execute(sql`
    SELECT
      s.id,
      s.form_id,
      s.organization_id,
      s.submitted_by_email,
      s.submitted_at,
      s.processed,
      f.name AS form_name,
      f.slug AS form_slug,
      f.confirmation_type,
      f.confirmation_message,
      f.notify_on_submit,
      f.notify_emails,
      f.notify_banter_channel_id
    FROM blank_submissions s
    INNER JOIN blank_forms f ON f.id = s.form_id
    WHERE s.processed = false
      AND (
        f.notify_on_submit = true
        OR f.notify_banter_channel_id IS NOT NULL
        OR (s.submitted_by_email IS NOT NULL AND f.confirmation_type <> 'none')
      )
    ORDER BY s.submitted_at ASC
    LIMIT ${limit}
  `);
  const rows = Array.isArray(rowsRaw) ? rowsRaw : ((rowsRaw as { rows?: unknown[] }).rows ?? []);
  return rows as SubmissionRow[];
}

async function markSubmissionProcessed(submissionId: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    UPDATE blank_submissions
    SET processed = true, bolt_event_emit_error = NULL
    WHERE id = ${submissionId}
  `);
}

async function markSubmissionFailed(submissionId: string, message: string): Promise<void> {
  const db = getDb();
  await db.execute(sql`
    UPDATE blank_submissions
    SET bolt_event_emit_error = ${message.slice(0, 500)}
    WHERE id = ${submissionId}
  `);
}

async function processSubmission(
  submission: SubmissionRow,
  env: Env,
  redis: Redis,
  logger: Logger,
): Promise<boolean> {
  if (submission.processed) {
    logger.debug({ submissionId: submission.id }, 'blank-confirmation-email: already processed, skipping');
    return false;
  }

  try {
    const db = getDb();
    const cfg = await getSmtpConfig(db, env);
    const transport = cfg
      ? nodemailer.createTransport({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure,
          auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
        })
      : null;

    const formLabel = submission.form_name;
    const submittedAt = submission.submitted_at.toISOString?.() ?? String(submission.submitted_at);

    // 1. Confirmation email to the submitter.
    if (submission.submitted_by_email && (submission.confirmation_type ?? 'message') !== 'none') {
      const subject = `We received your submission: ${formLabel}`;
      const body =
        submission.confirmation_message ??
        `Thanks for submitting ${formLabel}. We have received your response.`;
      const html = `<p>${escapeHtml(body)}</p><p style="color:#6b7280;font-size:13px;">Form: ${escapeHtml(formLabel)}</p>`;
      if (transport && cfg) {
        await transport.sendMail({
          from: cfg.from,
          to: submission.submitted_by_email,
          subject,
          text: body,
          html,
        });
        logger.info(
          { submissionId: submission.id, to: submission.submitted_by_email },
          'blank-confirmation-email: confirmation email sent',
        );
      } else {
        logger.info(
          { submissionId: submission.id, to: submission.submitted_by_email, subject, body },
          'blank-confirmation-email: SMTP not configured, logging confirmation',
        );
      }
    }

    // 2. Notification emails to the form owner's configured recipients.
    if (submission.notify_on_submit && submission.notify_emails && submission.notify_emails.length > 0) {
      const subject = `New submission: ${formLabel}`;
      const submitterLine = submission.submitted_by_email
        ? `Submitted by: ${submission.submitted_by_email}`
        : 'Submitted anonymously.';
      const body = [
        `A new submission for form "${formLabel}" arrived at ${submittedAt}.`,
        submitterLine,
      ].join('\n');
      const html =
        `<p>A new submission for form <strong>${escapeHtml(formLabel)}</strong> arrived at ${escapeHtml(submittedAt)}.</p>` +
        `<p>${escapeHtml(submitterLine)}</p>`;

      for (const recipient of submission.notify_emails) {
        if (transport && cfg) {
          await transport.sendMail({ from: cfg.from, to: recipient, subject, text: body, html });
          logger.info({ submissionId: submission.id, to: recipient }, 'blank-confirmation-email: notification email sent');
        } else {
          logger.info(
            { submissionId: submission.id, to: recipient, subject, body },
            'blank-confirmation-email: SMTP not configured, logging notification',
          );
        }
      }
    }

    // 3. Banter notification post to the form's configured channel.
    let notifiedBanter = false;
    if (submission.notify_banter_channel_id) {
      const submitterText = submission.submitted_by_email
        ? `from **${submission.submitted_by_email}**`
        : 'from an anonymous visitor';
      const content = `New **${formLabel}** form submission ${submitterText}.`;
      const messageId = await postBanterChannelMessage(
        redis,
        {
          channelId: submission.notify_banter_channel_id,
          orgId: submission.organization_id,
          content,
          metadata: {
            event_type: 'blank.submission.created',
            form_id: submission.form_id,
            form_slug: submission.form_slug,
            submission_id: submission.id,
          },
        },
        logger,
      );
      notifiedBanter = messageId !== null;
      if (notifiedBanter) {
        logger.info(
          { submissionId: submission.id, channelId: submission.notify_banter_channel_id, messageId },
          'blank-confirmation-email: Banter notification posted',
        );
      }
    }

    await markSubmissionProcessed(submission.id);

    await publishBoltEvent(
      'submission.confirmation_sent',
      'blank',
      {
        submission_id: submission.id,
        form_id: submission.form_id,
        form_slug: submission.form_slug,
        notified_submitter: Boolean(submission.submitted_by_email),
        notification_recipients_count: submission.notify_on_submit ? submission.notify_emails?.length ?? 0 : 0,
        notified_banter: notifiedBanter,
      },
      submission.organization_id,
      undefined,
      'system',
    );

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { submissionId: submission.id, err: message },
      'blank-confirmation-email: failed to send',
    );
    await markSubmissionFailed(submission.id, message);
    return false;
  }
}

export async function processBlankConfirmationEmailJob(
  job: Job<BlankConfirmationEmailJobData>,
  env: Env,
  redis: Redis,
  logger: Logger,
): Promise<void> {
  const data = job.data ?? {};

  if (data.submission_id) {
    logger.info({ jobId: job.id, submissionId: data.submission_id }, 'blank-confirmation-email: direct job');
    const submission = await loadSubmissionById(data.submission_id);
    if (!submission) {
      logger.warn({ submissionId: data.submission_id }, 'blank-confirmation-email: submission not found');
      return;
    }
    await processSubmission(submission, env, redis, logger);
    return;
  }

  const limit = data.limit ?? 50;
  const submissions = await findPendingSubmissions(limit);
  if (submissions.length === 0) {
    logger.debug('blank-confirmation-email: sweep found no pending submissions');
    return;
  }
  logger.info(
    { jobId: job.id, candidates: submissions.length },
    'blank-confirmation-email: sweep start',
  );

  let sent = 0;
  let failed = 0;
  for (const sub of submissions) {
    const ok = await processSubmission(sub, env, redis, logger);
    if (ok) sent += 1;
    else failed += 1;
  }
  logger.info(
    { jobId: job.id, candidates: submissions.length, sent, failed },
    'blank-confirmation-email: sweep complete',
  );
}
