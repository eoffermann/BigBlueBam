import { eq } from 'drizzle-orm';
import { env } from '../env.js';
import { db } from '../db/index.js';
import {
  organizations,
  users,
  blastTemplates,
  blastSegments,
  blastCampaigns,
} from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// Enriched payload builders (Phase B / Tier 1)
//
// Each builder joins the relevant auxiliary tables and returns a full
// payload matching the schema declared in bolt-api's event-catalog.ts. All
// joins are best-effort: if a lookup fails the corresponding fields are
// left undefined so the event still publishes.
// ---------------------------------------------------------------------------

type CampaignRow = typeof blastCampaigns.$inferSelect;

export interface CampaignEventContext {
  campaign: CampaignRow;
  orgId: string;
  actorId: string;
}

function campaignUrl(campaignId: string): string {
  const base = env.TRACKING_BASE_URL.replace(/\/+$/, '');
  return `${base}/blast/campaigns/${campaignId}`;
}

async function loadOrg(orgId: string) {
  try {
    const [org] = await db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return org ?? null;
  } catch {
    return null;
  }
}

async function loadActor(userId: string) {
  try {
    const [user] = await db
      .select({ id: users.id, name: users.display_name, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return user ?? null;
  } catch {
    return null;
  }
}

async function loadTemplateName(templateId: string | null) {
  if (!templateId) return null;
  try {
    const [row] = await db
      .select({ name: blastTemplates.name })
      .from(blastTemplates)
      .where(eq(blastTemplates.id, templateId))
      .limit(1);
    return row?.name ?? null;
  } catch {
    return null;
  }
}

async function loadSegment(segmentId: string | null) {
  if (!segmentId) return null;
  try {
    const [row] = await db
      .select({ name: blastSegments.name, cached_count: blastSegments.cached_count })
      .from(blastSegments)
      .where(eq(blastSegments.id, segmentId))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the enriched common set of `campaign.*`, `actor.*`, `org.*` fields
 * shared by all campaign lifecycle events.
 */
export async function buildCampaignEventPayload(
  ctx: CampaignEventContext,
): Promise<Record<string, unknown>> {
  const { campaign, orgId, actorId } = ctx;

  const [org, actor, templateName, segment] = await Promise.all([
    loadOrg(orgId),
    loadActor(actorId),
    loadTemplateName(campaign.template_id),
    loadSegment(campaign.segment_id),
  ]);

  return {
    'campaign.id': campaign.id,
    'campaign.name': campaign.name,
    'campaign.subject': campaign.subject,
    'campaign.status': campaign.status,
    'campaign.template_id': campaign.template_id ?? undefined,
    'campaign.template_name': templateName ?? undefined,
    'campaign.segment_id': campaign.segment_id ?? undefined,
    'campaign.segment_name': segment?.name ?? undefined,
    'campaign.from_name': campaign.from_name ?? undefined,
    'campaign.from_email': campaign.from_email ?? undefined,
    // Canonical sender alias requested by the strategy doc.
    'campaign.from_address': campaign.from_email ?? undefined,
    'campaign.reply_to': campaign.reply_to_email ?? undefined,
    'campaign.recipient_count': campaign.recipient_count ?? undefined,
    'campaign.expected_recipient_count': segment?.cached_count ?? undefined,
    'campaign.sent_at': campaign.sent_at?.toISOString() ?? undefined,
    'campaign.scheduled_at': campaign.scheduled_at?.toISOString() ?? undefined,
    'campaign.url': campaignUrl(campaign.id),

    'actor.id': actorId,
    'actor.name': actor?.name ?? undefined,
    'actor.email': actor?.email ?? undefined,

    'org.id': orgId,
    'org.name': org?.name ?? undefined,
    'org.slug': org?.slug ?? undefined,
  };
}
