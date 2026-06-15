import { eq, and, desc, sql } from 'drizzle-orm';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { db, connection } from '../db/index.js';
import { env } from '../env.js';
import {
  blastCampaigns,
  blastSendLog,
  blastEngagementEvents,
} from '../db/schema/index.js';
import { notFound, badRequest } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// BullMQ queue for blast:send jobs (producer side only)
// ---------------------------------------------------------------------------

interface BlastSendJobData {
  campaign_id: string;
  org_id: string;
}

let _blastQueue: Queue<BlastSendJobData> | null = null;

function getBlastQueue(): Queue<BlastSendJobData> {
  if (!_blastQueue) {
    const connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    _blastQueue = new Queue<BlastSendJobData>('blast-send', { connection });
  }
  return _blastQueue;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CampaignFilters {
  organization_id: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface CreateCampaignInput {
  name: string;
  template_id?: string;
  subject: string;
  html_body: string;
  plain_text_body?: string;
  segment_id?: string;
  from_name?: string;
  from_email?: string;
  reply_to_email?: string;
}

export interface UpdateCampaignInput extends Partial<CreateCampaignInput> {}

// ---------------------------------------------------------------------------
// List campaigns
// ---------------------------------------------------------------------------

export async function listCampaigns(filters: CampaignFilters) {
  const conditions = [eq(blastCampaigns.organization_id, filters.organization_id)];

  if (filters.status) {
    conditions.push(eq(blastCampaigns.status, filters.status));
  }

  const limit = Math.min(filters.limit ?? 50, 100);
  const offset = filters.offset ?? 0;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(blastCampaigns)
      .where(and(...conditions))
      .orderBy(desc(blastCampaigns.created_at))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(blastCampaigns)
      .where(and(...conditions)),
  ]);

  return {
    data: rows,
    total: countResult[0]?.count ?? 0,
    limit,
    offset,
  };
}

// ---------------------------------------------------------------------------
// Get campaign
// ---------------------------------------------------------------------------

export async function getCampaign(id: string, orgId: string) {
  const [campaign] = await db
    .select()
    .from(blastCampaigns)
    .where(and(eq(blastCampaigns.id, id), eq(blastCampaigns.organization_id, orgId)))
    .limit(1);

  if (!campaign) throw notFound('Campaign not found');
  return campaign;
}

// ---------------------------------------------------------------------------
// Create campaign
// ---------------------------------------------------------------------------

export async function createCampaign(
  input: CreateCampaignInput,
  orgId: string,
  userId: string,
) {
  // When the campaign doesn't set its own reply-to, fall back to the creator's
  // Bond per-user reply-to (bond_user_settings, migration 0189) so client
  // replies land in their monitored inbox instead of an unmonitored address.
  // Best-effort cross-app read: if Bond isn't deployed (table absent) we skip.
  let replyToEmail = input.reply_to_email;
  if (!replyToEmail) {
    try {
      const rows = await connection<{ reply_to_email: string | null }[]>`
        SELECT reply_to_email FROM bond_user_settings WHERE user_id = ${userId} LIMIT 1
      `;
      if (rows[0]?.reply_to_email) replyToEmail = rows[0].reply_to_email;
    } catch {
      // bond_user_settings not present in this deployment — skip the default.
    }
  }

  const [campaign] = await db
    .insert(blastCampaigns)
    .values({
      organization_id: orgId,
      name: input.name,
      template_id: input.template_id,
      subject: input.subject,
      html_body: input.html_body,
      plain_text_body: input.plain_text_body,
      segment_id: input.segment_id,
      from_name: input.from_name,
      from_email: input.from_email,
      reply_to_email: replyToEmail,
      status: 'draft',
      created_by: userId,
    })
    .returning();

  return campaign!;
}

// ---------------------------------------------------------------------------
// Update campaign (only draft/scheduled)
// ---------------------------------------------------------------------------

export async function updateCampaign(
  id: string,
  orgId: string,
  input: UpdateCampaignInput,
) {
  const existing = await getCampaign(id, orgId);
  if (existing.status !== 'draft' && existing.status !== 'scheduled') {
    throw badRequest('Can only update campaigns in draft or scheduled status');
  }

  const [updated] = await db
    .update(blastCampaigns)
    .set({
      ...input,
      updated_at: new Date(),
    })
    .where(and(eq(blastCampaigns.id, id), eq(blastCampaigns.organization_id, orgId)))
    .returning();

  if (!updated) throw notFound('Campaign not found');
  return updated;
}

// ---------------------------------------------------------------------------
// Delete campaign (only draft)
// ---------------------------------------------------------------------------

export async function deleteCampaign(id: string, orgId: string) {
  const existing = await getCampaign(id, orgId);
  if (existing.status !== 'draft') {
    throw badRequest('Can only delete campaigns in draft status');
  }

  const [deleted] = await db
    .delete(blastCampaigns)
    .where(and(eq(blastCampaigns.id, id), eq(blastCampaigns.organization_id, orgId)))
    .returning({ id: blastCampaigns.id });

  if (!deleted) throw notFound('Campaign not found');
  return deleted;
}

// ---------------------------------------------------------------------------
// Send campaign immediately
// ---------------------------------------------------------------------------

/**
 * Validate CAN-SPAM compliance for an email campaign body.
 *
 * CAN-SPAM Act requires:
 *  1. A functioning unsubscribe mechanism (link)
 *  2. A valid physical mailing address
 *
 * This check runs before send or schedule. It inspects the HTML body for
 * recognizable patterns and rejects the campaign if either is missing.
 */
function validateCanSpamCompliance(htmlBody: string): void {
  const lowerBody = htmlBody.toLowerCase();

  // Check for unsubscribe link: look for href containing "unsub" or
  // common unsubscribe patterns (/unsub, /unsubscribe, {{unsubscribe_url}})
  const hasUnsubscribeLink =
    lowerBody.includes('unsub') ||
    lowerBody.includes('opt-out') ||
    lowerBody.includes('opt out') ||
    lowerBody.includes('{{unsubscribe_url}}') ||
    lowerBody.includes('%unsubscribe_url%');

  if (!hasUnsubscribeLink) {
    throw badRequest(
      'CAN-SPAM compliance: email body must contain an unsubscribe link. ' +
      'Include a link with "unsubscribe" or use the {{unsubscribe_url}} template variable.',
    );
  }

  // Check for physical mailing address: look for patterns that suggest a
  // street address is present (number + street-like text, or common address
  // template variables). This is a heuristic, not a full address parser.
  const hasAddress =
    /\d{1,5}\s+\w+\s+(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|suite|ste)\b/i.test(htmlBody) ||
    lowerBody.includes('{{physical_address}}') ||
    lowerBody.includes('%physical_address%') ||
    lowerBody.includes('p.o. box') ||
    lowerBody.includes('po box');

  if (!hasAddress) {
    throw badRequest(
      'CAN-SPAM compliance: email body must contain a valid physical mailing address. ' +
      'Include your organization\'s street address or use the {{physical_address}} template variable.',
    );
  }
}

export async function sendCampaign(id: string, orgId: string) {
  const campaign = await getCampaign(id, orgId);
  if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
    throw badRequest('Can only send campaigns in draft or scheduled status');
  }

  // CAN-SPAM compliance check before sending
  validateCanSpamCompliance(campaign.html_body);

  // Transition to 'sending' -- the worker will handle actual delivery
  const [updated] = await db
    .update(blastCampaigns)
    .set({
      status: 'sending',
      sent_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(blastCampaigns.id, id))
    .returning();

  // Enqueue a BullMQ job for the worker to process asynchronously
  await getBlastQueue().add(
    `blast-send-${id}`,
    { campaign_id: id, org_id: orgId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  );

  return updated!;
}

// ---------------------------------------------------------------------------
// Schedule campaign
// ---------------------------------------------------------------------------

export async function scheduleCampaign(id: string, orgId: string, scheduledAt: string) {
  const campaign = await getCampaign(id, orgId);
  if (campaign.status !== 'draft') {
    throw badRequest('Can only schedule campaigns in draft status');
  }

  // CAN-SPAM compliance check before scheduling
  validateCanSpamCompliance(campaign.html_body);

  const date = new Date(scheduledAt);
  if (date <= new Date()) {
    throw badRequest('Scheduled time must be in the future');
  }

  const [updated] = await db
    .update(blastCampaigns)
    .set({
      status: 'scheduled',
      scheduled_at: date,
      updated_at: new Date(),
    })
    .where(eq(blastCampaigns.id, id))
    .returning();

  return updated!;
}

// ---------------------------------------------------------------------------
// Pause campaign
// ---------------------------------------------------------------------------

export async function pauseCampaign(id: string, orgId: string) {
  const campaign = await getCampaign(id, orgId);
  if (campaign.status !== 'sending') {
    throw badRequest('Can only pause campaigns that are currently sending');
  }

  const [updated] = await db
    .update(blastCampaigns)
    .set({ status: 'paused', updated_at: new Date() })
    .where(eq(blastCampaigns.id, id))
    .returning();

  return updated!;
}

// ---------------------------------------------------------------------------
// Cancel campaign
// ---------------------------------------------------------------------------

export async function cancelCampaign(id: string, orgId: string) {
  const campaign = await getCampaign(id, orgId);
  if (campaign.status !== 'scheduled' && campaign.status !== 'sending' && campaign.status !== 'paused') {
    throw badRequest('Can only cancel campaigns that are scheduled, sending, or paused');
  }

  const [updated] = await db
    .update(blastCampaigns)
    .set({ status: 'cancelled', updated_at: new Date() })
    .where(eq(blastCampaigns.id, id))
    .returning();

  return updated!;
}

// ---------------------------------------------------------------------------
// Get campaign analytics
// ---------------------------------------------------------------------------

export async function getCampaignAnalytics(id: string, orgId: string) {
  const campaign = await getCampaign(id, orgId);

  // Get event breakdown
  const events = await db
    .select({
      event_type: blastEngagementEvents.event_type,
      count: sql<number>`count(*)::int`,
    })
    .from(blastEngagementEvents)
    .where(eq(blastEngagementEvents.campaign_id, id))
    .groupBy(blastEngagementEvents.event_type);

  const eventMap: Record<string, number> = {};
  for (const e of events) {
    eventMap[e.event_type] = e.count;
  }

  // Click URL breakdown
  const clickUrls = await db
    .select({
      url: blastEngagementEvents.clicked_url,
      count: sql<number>`count(*)::int`,
    })
    .from(blastEngagementEvents)
    .where(
      and(
        eq(blastEngagementEvents.campaign_id, id),
        eq(blastEngagementEvents.event_type, 'click'),
      ),
    )
    .groupBy(blastEngagementEvents.clicked_url)
    .orderBy(desc(sql`count(*)`))
    .limit(20);

  // Delivery status breakdown
  const deliveryStatus = await db
    .select({
      status: blastSendLog.status,
      count: sql<number>`count(*)::int`,
    })
    .from(blastSendLog)
    .where(eq(blastSendLog.campaign_id, id))
    .groupBy(blastSendLog.status);

  const deliveryMap: Record<string, number> = {};
  for (const d of deliveryStatus) {
    deliveryMap[d.status] = d.count;
  }

  const totalSent = campaign.total_sent ?? 0;
  const openRate = totalSent > 0 ? ((campaign.total_opened ?? 0) / totalSent) * 100 : 0;
  const clickRate = totalSent > 0 ? ((campaign.total_clicked ?? 0) / totalSent) * 100 : 0;
  const bounceRate = totalSent > 0 ? ((campaign.total_bounced ?? 0) / totalSent) * 100 : 0;
  const unsubRate = totalSent > 0 ? ((campaign.total_unsubscribed ?? 0) / totalSent) * 100 : 0;

  return {
    campaign_id: id,
    total_sent: totalSent,
    total_delivered: campaign.total_delivered ?? 0,
    total_opened: campaign.total_opened ?? 0,
    total_clicked: campaign.total_clicked ?? 0,
    total_bounced: campaign.total_bounced ?? 0,
    total_unsubscribed: campaign.total_unsubscribed ?? 0,
    total_complained: campaign.total_complained ?? 0,
    open_rate: Math.round(openRate * 100) / 100,
    click_rate: Math.round(clickRate * 100) / 100,
    bounce_rate: Math.round(bounceRate * 100) / 100,
    unsubscribe_rate: Math.round(unsubRate * 100) / 100,
    event_breakdown: eventMap,
    click_urls: clickUrls,
    delivery_breakdown: deliveryMap,
  };
}

// ---------------------------------------------------------------------------
// Get campaign recipients
// ---------------------------------------------------------------------------

export async function getCampaignRecipients(
  id: string,
  orgId: string,
  limit = 50,
  offset = 0,
) {
  // Verify campaign belongs to org
  await getCampaign(id, orgId);

  const rows = await db
    .select({
      id: blastSendLog.id,
      contact_id: blastSendLog.contact_id,
      to_email: blastSendLog.to_email,
      status: blastSendLog.status,
      sent_at: blastSendLog.sent_at,
      delivered_at: blastSendLog.delivered_at,
      bounced_at: blastSendLog.bounced_at,
      bounce_type: blastSendLog.bounce_type,
    })
    .from(blastSendLog)
    .where(eq(blastSendLog.campaign_id, id))
    .orderBy(desc(blastSendLog.created_at))
    .limit(Math.min(limit, 100))
    .offset(offset);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(blastSendLog)
    .where(eq(blastSendLog.campaign_id, id));

  return {
    data: rows,
    total: countResult?.count ?? 0,
    limit,
    offset,
  };
}
