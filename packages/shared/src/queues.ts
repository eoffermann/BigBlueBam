/**
 * Cross-service BullMQ job contracts shared between producers (apps/api)
 * and consumers (apps/worker), so the queue name + payload shape can't
 * drift between the two sides.
 */

/** Task-link external title-fetch (bam-csv-import plan §4.3 item 3). */
export const TASK_LINK_TITLE_FETCH_QUEUE = 'task-link-title-fetch';

/**
 * Blip durable-write fan-in (Blip §4.2). The ingest edge enqueues a redacted
 * batch; the worker extracts promoted fields, offloads captures, upserts the
 * field catalog, and bulk-inserts into the partitioned blip_entries table.
 */
export const BLIP_INGEST_QUEUE = 'blip-ingest';

/** One already-redacted report element queued for durable write. */
export interface BlipQueuedEntry {
  report_type: string;
  /** Full redacted payload (screen_captures still inline as base64 for offload). */
  payload: Record<string, unknown>;
}

export interface BlipIngestJobData {
  org_id: string;
  tracked_app_id: string;
  ingest_key_id: string;
  received_at: string; // ISO; server stamp from the edge
  entries: BlipQueuedEntry[];
}

/** Freeze a filtered collection to a Bin JSONL asset (Blip §14). */
export const BLIP_EXPORT_JSONL_QUEUE = 'blip-export-jsonl';
export interface BlipExportJobData {
  org_id: string;
  tracked_app_id: string;
  report_type: string;
  filter?: unknown;
  requested_by: string | null;
  asset_name: string;
}

/** Compile a timelapse video from capture-bearing entries (Blip §23.4). */
export const BLIP_TIMELAPSE_QUEUE = 'blip-timelapse';
export interface BlipTimelapseJobData {
  job_id: string;
  org_id: string;
  tracked_app_id: string;
}

/** Concurrent expression-index creation for a promoted field (Blip §7.3). */
export const BLIP_FIELD_INDEX_QUEUE = 'blip-field-index';
export interface BlipFieldIndexJobData {
  org_id: string;
  tracked_app_id: string;
  report_type: string;
  field_path: string;
}

export interface TaskLinkTitleFetchJobData {
  task_id: string;
  link_id: string;
  url: string;
}

/**
 * Braid identity-resolution match-on-ingest (Braid design spec §4 / §6). The
 * braid-api /internal/events route (fed by bolt-api dispatch) and the lazy
 * resolve path both enqueue a refs-only job; the worker reads the source row
 * directly, normalizes, blocks, scores, and routes to an autonomy band. Shared
 * so the producer (braid-api) and consumer (worker) can't drift on the queue
 * name or payload shape.
 */
export const BRAID_MATCH_ON_INGEST_QUEUE = 'braid-match-on-ingest';

export interface BraidMatchOnIngestJobData {
  org_id: string;
  /** Dotted source identity type, e.g. 'bond.contact' | 'book.event_attendee'. */
  source_type: string;
  /** Source-app row id. */
  source_id: string;
  /** Optional hint that this identity was just lazily seeded by resolve. */
  seeded?: boolean;
}

/**
 * Banter Feed fan-in (docs/plans/banter-feed-design-document.md §10). Producers
 * (banter-api message routes, later other apps) enqueue one job per platform
 * activity event; the worker classifies it, resolves concerned users, and
 * upserts banter_feed_entries.
 */
export const BANTER_FEED_FANIN_QUEUE = 'banter-feed-fanin';

/**
 * A producer-resolved Path A (direct) recipient: the user, their
 * relationship-flag bitset, and the Feed category their entry should carry
 * (e.g. an @mention → 'banter.mention'). The worker still runs can_access +
 * subscription resolution per recipient before upserting.
 */
export interface FeedDirectRecipient {
  user_id: string;
  relationship_flags: number;
  category: string;
}

export interface BanterFeedFaninJobData {
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
  /** Producer-resolved Path A recipients with their per-user category + flags. */
  direct_recipients?: FeedDirectRecipient[];
  /** Category for Path B (broad/followed-scope) recipients; null = no broad surfacing. */
  broad_category?: string | null;
  /** How the worker enumerates broad recipients. 'channel' = the channel's members. */
  broad_scope?: 'channel' | 'project' | 'source' | null;
  /** @mentioned user ids (subset of direct recipients), for notification routing. */
  mentioned_user_ids?: string[];
  /**
   * Notification text (§12). When set AND the category fires a notification for
   * a recipient AND the Feed owns that category's notification, the fan-in
   * writes a `notifications` row deep-linking to the feed permalink. Producers
   * leave these unset for categories whose notification a legacy path owns.
   */
  notification_title?: string;
  notification_body?: string;
}
