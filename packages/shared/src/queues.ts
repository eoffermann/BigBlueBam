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
 * Bulwark (AI contract-obligation monitor) queues (Bulwark design spec §4 / §9.2).
 * bulwark-api is the PRODUCER (the POST /contracts + /extract routes enqueue extraction;
 * the /internal/events inbox-write enqueues the firing drain); the worker (apps/worker,
 * landed in a later milestone) is the consumer. Shared so producer and consumer cannot
 * drift on the queue name or payload shape.
 */
export const BULWARK_EXTRACT_OBLIGATIONS_QUEUE = 'bulwark-extract-obligations';
export interface BulwarkExtractObligationsJobData {
  org_id: string;
  contract_id: string;
}

/** Inbox drain: match one durably-inboxed Bolt event against armed obligations (§4.2). */
export const BULWARK_FIRE_ON_EVENT_QUEUE = 'bulwark-fire-on-event';
export interface BulwarkFireOnEventJobData {
  org_id: string;
  ingest_event_id: string;
}

/**
 * Scheduled Bulwark sweeps (Bulwark spec §4.3-§4.5). Each of these is a repeatable job whose
 * worker handler is a THIN caller: it POSTs to a bulwark-api internal route that runs the
 * engine over every org, so all engine logic stays in one place (bulwark-api). The optional
 * organization_id scopes a targeted run.
 */
export const BULWARK_RADAR_SWEEP_QUEUE = 'bulwark-radar-sweep';
export const BULWARK_STATE_RECONCILE_QUEUE = 'bulwark-state-reconcile';
export const BULWARK_PROPOSAL_RECONCILE_QUEUE = 'bulwark-proposal-reconcile';
export const BULWARK_GATE_RECONCILE_QUEUE = 'bulwark-gate-reconcile';
export const BULWARK_RETENTION_QUEUE = 'bulwark-retention';
export interface BulwarkSweepJobData {
  organization_id?: string;
}

/**
 * Burn (contract-consumption / scope-gate monitor) queues (Burn design spec §4 / §8.1).
 * burn-api is the engine host; every worker job is a THIN HTTP caller that POSTs to a
 * burn-api internal engine route so all business logic and every LLM call live in one
 * container (spec 4.0). Shared so the producer (burn-api) and the consumer (apps/worker)
 * cannot drift on the queue name or the payload shape.
 *
 * 10 job families plus the claim reaper = 11 queues. The two LLM-calling families
 * (extract, attribute) use row claims + per-chunk checkpoints as their correctness
 * mechanism because no advisory-lock-holding transaction may contain an outbound HTTP call
 * (spec 4.0 point 4, R3-T1); the SQL-only sweeps hold a per-org pg_advisory_xact_lock
 * inside burn-api.
 */
export const BURN_EXTRACT_DELIVERABLES_QUEUE = 'burn-extract-deliverables';
export interface BurnExtractDeliverablesJobData {
  organization_id: string;
  engagement_id: string;
}

export const BURN_ATTRIBUTE_BATCH_QUEUE = 'burn-attribute-batch';
export const BURN_CLAIM_REAPER_QUEUE = 'burn-claim-reaper';
export const BURN_VARIANCE_SWEEP_QUEUE = 'burn-variance-sweep';
export const BURN_REVALUE_QUEUE = 'burn-revalue';
export const BURN_SILENT_DELIVERABLE_SWEEP_QUEUE = 'burn-silent-deliverable-sweep';
export const BURN_ROLLUP_REFRESH_QUEUE = 'burn-rollup-refresh';
export const BURN_CALIBRATION_RECOMPUTE_QUEUE = 'burn-calibration-recompute';
export const BURN_PROPOSAL_RECONCILE_QUEUE = 'burn-proposal-reconcile';
export const BURN_RETENTION_QUEUE = 'burn-retention';
export const BURN_EMBED_SYNC_QUEUE = 'burn-embed-sync';

/** Optional org scope for a targeted engine run; absent means iterate every org. */
export interface BurnSweepJobData {
  organization_id?: string;
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
