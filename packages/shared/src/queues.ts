/**
 * Cross-service BullMQ job contracts shared between producers (apps/api)
 * and consumers (apps/worker), so the queue name + payload shape can't
 * drift between the two sides.
 */

/** Task-link external title-fetch (bam-csv-import plan §4.3 item 3). */
export const TASK_LINK_TITLE_FETCH_QUEUE = 'task-link-title-fetch';

export interface TaskLinkTitleFetchJobData {
  task_id: string;
  link_id: string;
  url: string;
}

/**
 * Banter Feed fan-in (docs/plans/banter-feed-design-document.md §10). Producers
 * (banter-api message routes, later other apps) enqueue one job per platform
 * activity event; the worker classifies it, resolves concerned users, and
 * upserts banter_feed_entries.
 */
export const BANTER_FEED_FANIN_QUEUE = 'banter-feed-fanin';

export interface BanterFeedFaninJobData {
  /** Canonical Feed category (§8), e.g. 'banter.channel_post'. */
  category: string;
  /** Canonical entity_type the entry points at, e.g. 'banter.message'. */
  entity_type: string;
  entity_id: string;
  /** Owning app, used for subscription resolution (§5). */
  source: string;
  org_id: string;
  /** The actor who caused the event (excluded from their own feed). */
  actor_id?: string | null;
  /** Grouping root (thread root, parent task); null = self. */
  root_entity_type?: string | null;
  root_entity_id?: string | null;
  channel_id?: string | null;
  project_id?: string | null;
  /** ISO timestamps; the worker bumps last_activity_at on re-activity. */
  published_at: string;
  last_activity_at: string;
  /** Denormalized comment+reaction+participant tally for social proof. */
  engagement_count?: number;
  /**
   * Explicit direct-relationship recipients (Path A) keyed by user id, each a
   * relationship-flag bitset. The worker still runs can_access + subscription
   * resolution per user before upserting.
   */
  direct_recipients?: Record<string, number>;
  /** @mentioned user ids (subset of direct recipients, for notification routing). */
  mentioned_user_ids?: string[];
}
