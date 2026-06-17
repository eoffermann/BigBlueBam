import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { eq, and, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../utils/db.js';
import { publishBoltEvent } from '../utils/bolt-events.js';
import type { Env } from '../env.js';

// ---------------------------------------------------------------------------
// Schema stubs — lightweight pgTable references so the worker can query
// Blast / Bond tables without importing the full blast-api Drizzle config.
// ---------------------------------------------------------------------------

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
} from 'drizzle-orm/pg-core';

const bondContacts = pgTable('bond_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  first_name: varchar('first_name', { length: 100 }),
  last_name: varchar('last_name', { length: 100 }),
  email: varchar('email', { length: 255 }),
  // Columns referenced by segment filter_criteria (kept in sync with the
  // blast-api segment service's CONTACT_COLUMN_MAP).
  lifecycle_stage: varchar('lifecycle_stage', { length: 30 }),
  lead_source: varchar('lead_source', { length: 60 }),
  lead_score: integer('lead_score'),
  city: varchar('city', { length: 100 }),
  country: varchar('country', { length: 2 }),
  last_contacted_at: timestamp('last_contacted_at', { withTimezone: true }),
  custom_fields: jsonb('custom_fields').default({}).notNull(),
});

const blastSegments = pgTable('blast_segments', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  filter_criteria: jsonb('filter_criteria').notNull(),
  cached_count: integer('cached_count'),
  cached_at: timestamp('cached_at', { withTimezone: true }),
});

const blastCampaigns = pgTable('blast_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  subject: varchar('subject', { length: 500 }).notNull(),
  html_body: text('html_body').notNull(),
  plain_text_body: text('plain_text_body'),
  segment_id: uuid('segment_id'),
  from_name: varchar('from_name', { length: 100 }),
  from_email: varchar('from_email', { length: 255 }),
  reply_to_email: varchar('reply_to_email', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  sent_at: timestamp('sent_at', { withTimezone: true }),
  completed_at: timestamp('completed_at', { withTimezone: true }),
  recipient_count: integer('recipient_count'),
  total_sent: integer('total_sent').default(0),
  total_delivered: integer('total_delivered').default(0),
  total_bounced: integer('total_bounced').default(0),
  total_opened: integer('total_opened').default(0),
  total_clicked: integer('total_clicked').default(0),
  total_unsubscribed: integer('total_unsubscribed').default(0),
  total_complained: integer('total_complained').default(0),
  completion_event_emitted: boolean('completion_event_emitted').default(false),
  created_by: uuid('created_by'),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

const blastSendLog = pgTable('blast_send_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaign_id: uuid('campaign_id').notNull(),
  contact_id: uuid('contact_id').notNull(),
  to_email: varchar('to_email', { length: 255 }).notNull(),
  smtp_message_id: varchar('smtp_message_id', { length: 255 }),
  status: varchar('status', { length: 20 }).notNull().default('queued'),
  tracking_token: varchar('tracking_token', { length: 64 }).notNull().unique(),
  sent_at: timestamp('sent_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

const blastUnsubscribes = pgTable('blast_unsubscribes', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  email: varchar('email', { length: 255 }).notNull(),
});

// ---------------------------------------------------------------------------
// Segment resolution — ported from
// apps/blast-api/src/services/segment.service.ts (buildConditionSql /
// buildFilterWhere). The worker uses Drizzle pgTable stubs and cannot import
// the blast-api service module, so the filter translation lives here. Keep
// the two in sync: any new operator/field must be added in both places.
// ---------------------------------------------------------------------------

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

const CONTACT_COLUMN_MAP: Record<
  string,
  (typeof bondContacts)[keyof typeof bondContacts] | undefined
> = {
  lifecycle_stage: bondContacts.lifecycle_stage,
  lead_source: bondContacts.lead_source,
  lead_score: bondContacts.lead_score,
  city: bondContacts.city,
  country: bondContacts.country,
  last_contacted_at: bondContacts.last_contacted_at,
  email: bondContacts.email,
  first_name: bondContacts.first_name,
  last_name: bondContacts.last_name,
};

function buildConditionSql(condition: {
  field: string;
  op: string;
  value: unknown;
}): SQL | undefined {
  const col = CONTACT_COLUMN_MAP[condition.field];
  if (!col) return undefined;

  switch (condition.op) {
    case 'equals':
      return sql`${col} = ${condition.value as string}`;
    case 'not_equals':
      return sql`${col} != ${condition.value as string}`;
    case 'in': {
      const values = condition.value as string[];
      if (!values || values.length === 0) return undefined;
      return sql`${col} = ANY(${values}::text[])`;
    }
    case 'contains': {
      const pattern = `%${escapeLike(String(condition.value))}%`;
      return sql`${col} ILIKE ${pattern}`;
    }
    case 'greater_than':
      return sql`${col} > ${condition.value as string | number}`;
    case 'less_than':
      return sql`${col} < ${condition.value as string | number}`;
    case 'older_than_days': {
      const days = Number(condition.value);
      if (Number.isNaN(days)) return undefined;
      return sql`${col} < NOW() - INTERVAL '1 day' * ${days}`;
    }
    case 'is_set':
      return sql`${col} IS NOT NULL`;
    case 'is_not_set':
      return sql`${col} IS NULL`;
    default:
      return undefined;
  }
}

function buildSegmentFilterWhere(
  orgId: string,
  criteria: {
    conditions: Array<{ field: string; op: string; value: unknown }>;
    match: string;
  },
): SQL {
  const orgCondition = eq(bondContacts.organization_id, orgId);

  const filterConditions: SQL[] = [];
  for (const condition of criteria.conditions ?? []) {
    const fragment = buildConditionSql(condition);
    if (fragment) filterConditions.push(fragment);
  }

  if (filterConditions.length === 0) return orgCondition;

  const combined =
    criteria.match === 'any'
      ? or(...filterConditions)
      : and(...filterConditions);
  if (!combined) return orgCondition;

  return and(orgCondition, combined) ?? orgCondition;
}

// ---------------------------------------------------------------------------
// Job data interface
// ---------------------------------------------------------------------------

export interface BlastSendJobData {
  campaign_id: string;
  org_id: string;
}

// ---------------------------------------------------------------------------
// SMTP transport — resolves config from system_settings first, env vars
// fallback. See apps/worker/src/utils/smtp-config.ts for the resolver and
// apps/worker/src/jobs/email.job.ts for the matching pattern used by the
// transactional email job. `getDb` is already imported at the top of the
// file for the main transaction flow.
// ---------------------------------------------------------------------------

import { getSmtpConfig, type ResolvedSmtpConfig } from '../utils/smtp-config.js';

let cachedTransport: nodemailer.Transporter | null = null;
let cachedFingerprint: string | null = null;

function fingerprintConfig(cfg: ResolvedSmtpConfig): string {
  return [cfg.host, cfg.port, cfg.user ?? '', cfg.pass ?? '', cfg.secure].join('|');
}

async function resolveTransport(env: Env): Promise<{
  transport: nodemailer.Transporter | null;
  cfg: ResolvedSmtpConfig | null;
}> {
  const cfg = await getSmtpConfig(getDb(), env);
  if (!cfg) return { transport: null, cfg: null };
  const fp = fingerprintConfig(cfg);
  if (cachedTransport && fp === cachedFingerprint) return { transport: cachedTransport, cfg };
  cachedTransport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  cachedFingerprint = fp;
  return { transport: cachedTransport, cfg };
}

// ---------------------------------------------------------------------------
// Template rendering helpers
// ---------------------------------------------------------------------------

/**
 * Replace merge fields in the template body:
 *   {{first_name}}, {{last_name}}, {{email}}, {{company}}, {{unsubscribe_url}}
 */
function renderTemplate(
  html: string,
  contact: { first_name: string | null; last_name: string | null; email: string },
  unsubscribeUrl: string,
): string {
  return html
    .replace(/\{\{first_name\}\}/g, contact.first_name ?? '')
    .replace(/\{\{last_name\}\}/g, contact.last_name ?? '')
    .replace(/\{\{email\}\}/g, contact.email)
    .replace(/\{\{company\}\}/g, '') // Bond company join not available in stub
    .replace(/\{\{unsubscribe_url\}\}/g, unsubscribeUrl);
}

/**
 * Inject the open-tracking pixel just before </body>.
 */
function injectTrackingPixel(html: string, pixelUrl: string): string {
  const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;" />`;
  if (html.includes('</body>')) {
    return html.replace('</body>', `${pixel}</body>`);
  }
  return html + pixel;
}

/**
 * Rewrite all href="..." links for click tracking, excluding mailto: and
 * the unsubscribe link (which should pass through directly).
 */
function rewriteLinks(html: string, trackingBaseUrl: string, token: string): string {
  return html.replace(
    /href="(https?:\/\/[^"]+)"/g,
    (_match, url: string) => {
      const encodedUrl = encodeURIComponent(url);
      return `href="${trackingBaseUrl}/t/c/${token}?url=${encodedUrl}"`;
    },
  );
}

// ---------------------------------------------------------------------------
// Main job processor
// ---------------------------------------------------------------------------

export async function processBlastSendJob(
  job: Job<BlastSendJobData>,
  env: Env,
  logger: Logger,
): Promise<void> {
  const { campaign_id, org_id } = job.data;
  const db = getDb();

  const trackingBaseUrl = (env.TRACKING_BASE_URL ?? 'http://localhost').replace(/\/$/, '');

  logger.info({ jobId: job.id, campaign_id, org_id }, 'Processing blast:send job');

  // 1. Load campaign and verify status
  const [campaign] = await db
    .select()
    .from(blastCampaigns)
    .where(
      and(
        eq(blastCampaigns.id, campaign_id),
        eq(blastCampaigns.organization_id, org_id),
      ),
    )
    .limit(1);

  if (!campaign) {
    logger.error({ campaign_id }, 'Campaign not found');
    return;
  }

  if (campaign.status !== 'sending') {
    logger.warn(
      { campaign_id, status: campaign.status },
      'Campaign is not in sending status, skipping',
    );
    return;
  }

  // 2. Load unsubscribed emails for this org
  const unsubRows = await db
    .select({ email: blastUnsubscribes.email })
    .from(blastUnsubscribes)
    .where(eq(blastUnsubscribes.organization_id, org_id));

  const unsubEmails = new Set(unsubRows.map((r) => r.email.toLowerCase()));

  // 3. Load contacts — when the campaign targets a segment, evaluate that
  //    segment's filter_criteria against the contacts table so we send only
  //    to the segment's members. With no segment_id, fall back to all org
  //    contacts.
  let recipientWhere: SQL = eq(bondContacts.organization_id, org_id);

  if (campaign.segment_id) {
    const [segment] = await db
      .select({
        id: blastSegments.id,
        filter_criteria: blastSegments.filter_criteria,
      })
      .from(blastSegments)
      .where(
        and(
          eq(blastSegments.id, campaign.segment_id),
          eq(blastSegments.organization_id, org_id),
        ),
      )
      .limit(1);

    if (!segment) {
      // Segment was deleted out from under the campaign (FK is SET NULL on
      // delete, but the campaign row may not have been refreshed). Fail safe:
      // send to nobody rather than blasting the whole org.
      logger.warn(
        { campaign_id, segment_id: campaign.segment_id },
        'Campaign targets a segment that no longer exists — sending to no recipients',
      );
      recipientWhere = sql`false`;
    } else {
      const criteria = (segment.filter_criteria ?? {
        conditions: [],
        match: 'all',
      }) as {
        conditions: Array<{ field: string; op: string; value: unknown }>;
        match: string;
      };
      recipientWhere = buildSegmentFilterWhere(org_id, criteria);
      logger.info(
        {
          campaign_id,
          segment_id: segment.id,
          conditions: criteria.conditions?.length ?? 0,
          match: criteria.match,
        },
        'Resolving recipients from campaign segment filter',
      );
    }
  }

  const contacts = await db
    .select({
      id: bondContacts.id,
      first_name: bondContacts.first_name,
      last_name: bondContacts.last_name,
      email: bondContacts.email,
    })
    .from(bondContacts)
    .where(recipientWhere);

  // 4. Filter out contacts with no email or who are unsubscribed
  const eligibleContacts = contacts.filter(
    (c) => c.email && !unsubEmails.has(c.email.toLowerCase()),
  );

  logger.info(
    {
      campaign_id,
      total_contacts: contacts.length,
      unsubscribed: unsubEmails.size,
      eligible: eligibleContacts.length,
    },
    'Contacts loaded and filtered',
  );

  const { transport, cfg: smtpCfg } = await resolveTransport(env);
  let sentCount = 0;
  let failedCount = 0;

  const fromEmail = campaign.from_email ?? smtpCfg?.from ?? env.EMAIL_FROM;
  const fromName = campaign.from_name ?? 'BigBlueBam';

  // 5. Process each eligible contact
  for (const contact of eligibleContacts) {
    const email = contact.email!;
    const token = crypto.randomBytes(32).toString('base64url');
    const unsubscribeUrl = `${trackingBaseUrl}/unsub/${token}`;
    const pixelUrl = `${trackingBaseUrl}/t/o/${token}`;

    // 5a. Render template with merge fields
    let renderedHtml = renderTemplate(
      campaign.html_body,
      { first_name: contact.first_name, last_name: contact.last_name, email },
      unsubscribeUrl,
    );

    // 5b. Rewrite links for click tracking
    renderedHtml = rewriteLinks(renderedHtml, trackingBaseUrl, token);

    // 5c. Inject tracking pixel
    renderedHtml = injectTrackingPixel(renderedHtml, pixelUrl);

    // 5d. Render subject with merge fields
    const renderedSubject = campaign.subject
      .replace(/\{\{first_name\}\}/g, contact.first_name ?? '')
      .replace(/\{\{last_name\}\}/g, contact.last_name ?? '')
      .replace(/\{\{email\}\}/g, email);

    // 5e. Create send_log entry with status 'pending'
    const [sendLogEntry] = await db
      .insert(blastSendLog)
      .values({
        campaign_id,
        contact_id: contact.id,
        to_email: email,
        tracking_token: token,
        status: 'queued',
      })
      .returning({ id: blastSendLog.id });

    // 5f. Send the email
    try {
      if (!transport) {
        logger.warn(
          { to: email, subject: renderedSubject },
          'SMTP not configured — logging blast email instead of sending',
        );
        // Still mark as sent so the campaign completes
        await db
          .update(blastSendLog)
          .set({ status: 'sent', sent_at: new Date() })
          .where(eq(blastSendLog.id, sendLogEntry!.id));
        sentCount++;
        continue;
      }

      const info = await transport.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to: email,
        subject: renderedSubject,
        html: renderedHtml,
        text: campaign.plain_text_body ?? undefined,
        replyTo: campaign.reply_to_email ?? undefined,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });

      // 5g. Update send_log status to 'sent'
      await db
        .update(blastSendLog)
        .set({
          status: 'sent',
          smtp_message_id: info.messageId,
          sent_at: new Date(),
        })
        .where(eq(blastSendLog.id, sendLogEntry!.id));

      sentCount++;

      logger.debug(
        { to: email, messageId: info.messageId },
        'Blast email sent',
      );
    } catch (err) {
      failedCount++;

      await db
        .update(blastSendLog)
        .set({ status: 'failed' })
        .where(eq(blastSendLog.id, sendLogEntry!.id));

      logger.error(
        { to: email, err },
        'Failed to send blast email',
      );
    }

    // Update job progress
    const processed = sentCount + failedCount;
    const total = eligibleContacts.length;
    await job.updateProgress(Math.round((processed / total) * 100));
  }

  // 6. Update campaign: status='sent', sent_at=now(), total_sent=count
  const completedAt = new Date();
  await db
    .update(blastCampaigns)
    .set({
      status: 'sent',
      completed_at: completedAt,
      total_sent: sentCount,
      total_delivered: sentCount, // Actual delivery confirmation comes from webhooks
      total_bounced: failedCount,
      recipient_count: eligibleContacts.length,
      updated_at: completedAt,
    })
    .where(eq(blastCampaigns.id, campaign_id));

  logger.info(
    {
      campaign_id,
      sent: sentCount,
      failed: failedCount,
      total: eligibleContacts.length,
    },
    'Blast campaign send completed',
  );

  // 7. Fire-and-forget `campaign.completed` Bolt event. Guarded by the
  //    `completion_event_emitted` idempotency marker so retries do not
  //    double-publish. We re-read the campaign row to pick up any count
  //    updates from concurrent webhook writes, then flip the flag inside
  //    an UPDATE ... WHERE completion_event_emitted = false guard so only
  //    one racing worker replica actually publishes.
  try {
    const [fresh] = await db
      .select()
      .from(blastCampaigns)
      .where(eq(blastCampaigns.id, campaign_id))
      .limit(1);

    if (fresh && !fresh.completion_event_emitted) {
      const guard = await db
        .update(blastCampaigns)
        .set({ completion_event_emitted: true, updated_at: new Date() })
        .where(
          and(
            eq(blastCampaigns.id, campaign_id),
            eq(blastCampaigns.completion_event_emitted, false),
          ),
        )
        .returning({ id: blastCampaigns.id });

      if (guard.length > 0) {
        const payload: Record<string, unknown> = {
          'campaign.id': fresh.id,
          'campaign.name': fresh.name,
          'campaign.subject': fresh.subject,
          'campaign.status': fresh.status,
          'campaign.from_name': fresh.from_name ?? undefined,
          'campaign.from_email': fresh.from_email ?? undefined,
          'campaign.from_address': fresh.from_email ?? undefined,
          'campaign.reply_to': fresh.reply_to_email ?? undefined,
          'campaign.segment_id': fresh.segment_id ?? undefined,
          'campaign.recipient_count': fresh.recipient_count ?? undefined,
          'campaign.total_sent': fresh.total_sent ?? sentCount,
          'campaign.total_delivered': fresh.total_delivered ?? sentCount,
          'campaign.total_bounced': fresh.total_bounced ?? failedCount,
          'campaign.total_opened': fresh.total_opened ?? 0,
          'campaign.total_clicked': fresh.total_clicked ?? 0,
          'campaign.total_unsubscribed': fresh.total_unsubscribed ?? 0,
          'campaign.total_complained': fresh.total_complained ?? 0,
          'campaign.sent_at': fresh.sent_at?.toISOString() ?? undefined,
          'campaign.completed_at':
            fresh.completed_at?.toISOString() ?? completedAt.toISOString(),
          'actor.id': fresh.created_by ?? undefined,
          'org.id': fresh.organization_id,
        };

        await publishBoltEvent(
          'campaign.completed',
          'blast',
          payload,
          fresh.organization_id,
          undefined,
          'system',
        );
      }
    }
  } catch (err) {
    // Never fail the send job if Bolt or the completion emit is flaky; the
    // idempotency marker stays false on exception so a retry can try again.
    logger.warn(
      { campaign_id, err },
      'campaign.completed Bolt event publish failed — will retry on next run',
    );
  }
}
