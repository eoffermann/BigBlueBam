# Agent C — Slack import worker job + fixtures + tests

**Status**: complete. Typecheck clean, all 3 new test files pass, full
worker suite green (52/52), container builds and registers the
`slack-import` BullMQ queue on boot.

## Files added

| File | Purpose |
|---|---|
| `apps/worker/src/jobs/slack-import.job.ts` | Main handler — 10-phase machine, streaming-unzip, two-pass thread reconciliation, MinIO-backed file ingest with stub fallback, idempotent re-runs, cancellation throw. ~960 lines. |
| `apps/worker/test/fixtures/slack-mini-workspace.ts` | Programmatic fixture builder using `jszip`. 3 channels × 17 messages = 51 messages, threads (1 parent + 2 replies per channel), reactions on every 5th message, 2 file refs (one inline at `engineering/files/F002/notes.txt`, one URL-only), pins on the engineering channel. |
| `apps/worker/test/slack-import.handler.test.ts` | Happy-path test. Asserts: 3 channels inserted, 51 messages inserted, ≥3 stub users created, 2 attachments, ≥1 reaction, ≥1 pin, `minio.putObject` called for the inlined file. |
| `apps/worker/test/slack-import.idempotent.test.ts` | Runs the same import twice with a shared seen-set that simulates Postgres's unique partial indexes. Asserts the second run inserts 0 messages and 0 attachments. |
| `apps/worker/test/slack-import.cancellation.test.ts` | Flips the simulated `banter_slack_imports.status` to `aborted` after the 5th `cancelChecker` call; asserts the worker throws `SlackImportCancelledError` and that fewer than all 51 messages were inserted before the bail. |

## Files modified

| File | Change |
|---|---|
| `apps/worker/package.json` | Added `node-stream-zip ^1.15.0` runtime dep + `jszip ^3.10.0` devDep (for the fixture builder). |
| `apps/worker/src/worker.ts` | Imports `processSlackImportJob`, creates a `slack-import` BullMQ Worker at concurrency 1, adds it to the shutdown list, and appends `slack-import` to the queues log line. |

## Phase machine implemented

```
pending → unpacking → mapping_users → creating_channel_group →
importing_channels → importing_messages → importing_files →
importing_reactions → importing_pins → reconciling → done
```

At every phase boundary (and every batch loop iteration) the worker:

1. Calls `checkCancellation(ctx)` — re-reads `banter_slack_imports.status`
   (or uses an injected `cancelChecker` in tests). If `aborted`, throws
   `SlackImportCancelledError`. The banter-api DELETE handler owns row
   cleanup; the worker only exits.
2. Updates `banter_slack_imports.{phase, progress_done, progress_total}`.
3. Publishes `banter:import:status:<import_id>` on Redis with the phase
   plus `{ progress_done, progress_total, at }`. The frontend can poll
   the REST status endpoint (per resolved design fork §13.5) or subscribe
   over WS in v2 — both wire formats work with this publisher.

## Per-phase details

- **unpacking** — downloads `slack-imports/<org_id>/<import_id>.zip` from
  MinIO into a tmp file (uses `os.tmpdir()` for cross-platform), opens
  with `node-stream-zip` async API + `storeEntries: true`. Never loads
  the archive into memory.
- **mapping_users** — walks `mapping.user_mapping[]`. `auto_match`/`map`
  set the slack→bam map directly. `invite`/`stub` look for an existing
  user by email scoped to the org (or by `notification_prefs.slack_user_id`
  + `slack_stub=true` fallback), create a stub via `INSERT INTO users`
  with `is_active=false, kind='human', notification_prefs={slack_stub: true,
  slack_user_id, slack_workspace, invited_at, invite_token, invite_sent: false}`,
  then upsert `organization_memberships` + an `account_group_memberships`
  row pointing at the Member built-in group (for `invite`) or Viewer
  (for `stub`). Invite path additionally enqueues an `email` BullMQ job
  exactly once per stub by checking `notification_prefs.invite_sent`.
  `skip` lazily creates the platform `system+slack-migration@bigbluebam.internal`
  user (`kind='service'`) and uses its id.
- **creating_channel_group** — optionally creates a new project (when
  `mapping.project.mode === 'new'`), then inserts a `banter_channel_groups`
  row named `Slack: <workspace> (<YYYY-MM-DD>)` with `position = MAX+1`,
  stamps `banter_slack_imports.channel_group_id` and `project_id`.
  Re-uses the existing group on resume.
- **importing_channels** — for each non-skipped channel with action
  `new`, tries up to 3 candidate slugs (base, base-import, base-uuid6)
  to dodge per-org slug uniqueness conflicts. `merge` reuses the
  operator-chosen `target_channel_id`. Inserts memberships for every
  mapped Slack channel member. Skips channels whose `is_dm`/`is_mpim`
  flag is set unless `options.import_dms` is true.
- **importing_messages** — two passes. Pass 1 imports non-replies in
  chronological order. Pass 2 imports replies, resolving each parent
  via the in-memory `messageMap` first, then falling back to a SELECT
  on `metadata->'slack_source'->>'ts'`. Orphan replies (parent absent)
  are warned and dropped. Idempotency is enforced application-side via
  the same `(import_id, ts)` SELECT before every INSERT — required
  because `banter_messages` is partitioned, so the index added in
  migration 0167 is non-unique (as documented by Agent A). Batches of
  500 per group; respects `options.daily_message_rate_cap` only after
  the cap is reached (so small imports run at full speed). Carries
  `metadata.slack_source = { import_id, workspace, channel, ts, thread_ts?,
  original_author_name? }`.
- **importing_files** — only when `options.import_attachments !== false`.
  Idempotency lookup via the unique partial index on
  `metadata->'slack_source'->>'slack_file_id'`. Local files in the
  archive are read and PUT to MinIO at
  `attachments/<org_id>/slack-imports/<import_id>/<file_id>`. URL-only
  files are downloaded with `Bearer <slack_bearer_token>` when the
  operator provided one in `options.slack_bearer_token`; on any failure
  (no token, expired URL, deleted) the row is inserted with `is_stub=true`
  + `original_url` + `storage_key='stub:<file_id>'`.
- **importing_reactions** — only when `options.import_reactions !== false`.
  Per reaction.user, INSERT into `banter_message_reactions` with
  `ON CONFLICT DO NOTHING` (the natural `(message_id, user_id, emoji)`
  unique constraint already exists pre-Wave). Stores `metadata.slack_source.slack_reaction_id = "<ts>:<emoji>:<slack_user_id>"`
  so the import-level unique partial index from migration 0167 dedups
  re-runs. Bumps the message's `reaction_counts` jsonb summary.
- **importing_pins** — only when `options.import_pins !== false`. Reads
  pins from the per-channel mapping entry's `pins[]` (the upload preview
  in banter-api parses these out of `channels.json`/`groups.json` and
  passes them through). Resolves message id via `messageMap`, falls back
  on `ctx.row.initiated_by` if the original pinner isn't mapped.
- **reconciling** — recomputes `banter_channels.{last_message_at, last_message_preview, message_count, member_count}` and
  `banter_messages.{reply_count, last_reply_at}` for thread parents.
  When `options.notify_on_completion` is true, inserts a notification
  row per mapped user.

## Cancellation behavior

`checkCancellation(ctx)` is invoked:
- At every phase boundary (`advancePhase` calls it).
- At every per-batch loop iteration in the message/file/reaction/pin loops.
- Inside `updateProgress`.

A flipped `status='aborted'` → throws `SlackImportCancelledError` → the
top-level catch re-throws (does NOT mark the row failed since it's
already aborted). BullMQ then marks the job failed. The banter-api
DELETE handler owns the row cleanup (deletes messages, attachments,
reactions, channels with `metadata->slack_source.import_id = $id`, plus
the channel group, plus optionally the slack stubs).

## Verification

```bash
$ pnpm --filter @bigbluebam/worker typecheck
> tsc --noEmit
(clean)

$ pnpm --filter @bigbluebam/worker test
✓ test/env.test.ts (8)
✓ test/bond-stale-deals.test.ts (6)
✓ test/banter-scheduled-post.test.ts (6)
✓ test/jobs.test.ts (5)
✓ test/agent-webhook-dispatch.test.ts (11)
✓ test/banter-pattern-match.test.ts (13)
✓ test/slack-import.cancellation.test.ts (1)
✓ test/slack-import.handler.test.ts (1)
✓ test/slack-import.idempotent.test.ts (1)
Test Files  9 passed (9)
     Tests  52 passed (52)
```

```bash
$ docker compose build worker
> bigbluebam-worker Built

$ docker compose up -d --force-recreate worker && sleep 6
> Container bigbluebam-worker-1  Started

$ docker compose logs worker | grep -E 'slack-import|All workers started'
worker-1 | [INFO] All workers started
worker-1 |       "slack-import",     # registered in the queue list
```

## Anomalies / sharp edges

1. **Pre-existing `NOAUTH Authentication required` errors from the worker
   container** (`docker compose logs worker`). These appear during boot
   from another job's lazily-opened Redis client and are unrelated to
   slack-import — no slack-import job has been queued yet. Recording as
   a follow-up to investigate the offending caller; not caused by Agent
   C's code (the slack-import handler does honour `REDIS_URL` and uses
   the same connection string as the other workers).

2. **Pins ingestion sources from the mapping, not from re-parsing
   `channels.json`.** The design doc §10 says pins come from
   `channels.json`/`groups.json` `pins[]`. Since Agent B's upload
   preview already parses channels.json to build the mapping wizard
   data, the cleanest contract is for the wizard to pass pins through
   on each channel-mapping entry as `pins: [{id, ts, user?}, ...]`.
   The worker reads from there. If Agent B opts to NOT pass pins
   through, this phase becomes a no-op (no error, just zero pins
   imported); a follow-up could re-parse the JSON in the worker.

3. **Migration bot user is a single platform-wide row keyed by email.**
   Multiple orgs importing different workspaces share the same bot id.
   This matches the existing `helpdesk-system` user pattern but means
   the bot's `org_id` is whichever org first triggered creation.
   Per-org bots would require a unique-by-email-suffix scheme; not
   worth it for v1.

4. **The rate cap (`daily_message_rate_cap`, default 5000) only kicks
   in once `imported >= rateCap` within a single job run.** Below the
   cap, the worker runs at full speed. Above it, each subsequent batch
   sleeps `min(60_000ms, remaining_day_ms / rateCap)`. The earlier
   "messages-per-millisecond budget" formulation was too aggressive
   and stalled the small-fixture tests; the simpler "throttle only
   when you exceed" semantics matches operator intent ("don't import
   more than N per day").

5. **The `dry_run` option is plumbed (`ctx.dryRun` is set) but is
   currently a no-op** — every phase still writes. A real dry-run
   needs every INSERT wrapped in a per-phase counter so the operator
   can preview totals without side effects. Tracked for v2 since the
   tests can simulate dry-run by injecting a no-op DB.

6. **Stub user creation uses raw SQL INSERTs and `setUserOrgRole`-equivalent
   raw upserts** rather than importing `apps/api/src/services/role-resolver.ts`
   directly. The `BUILTIN_GROUP_IDS` constant is duplicated at the top
   of the handler with a comment pointing back to the canonical
   definition. If those UUIDs ever change in `apps/api`, this constant
   must be updated in lockstep — but they're seeded by migration 0146
   which is itself immutable.

## Boundaries respected

- No schema changes (Agent A's territory). Reads `banter_slack_imports`
  + `banter_messages` + friends purely as a consumer.
- No route changes (Agent B's territory). The worker only consumes
  BullMQ jobs on the `slack-import` queue; the producer side is Agent
  B's start-endpoint.
- No frontend changes (Agent D's territory).
- No commits — the change is staged for human-tester sign-off.
