# Banter Feed — implementation notes and sharp edges

Companion to `docs/plans/banter-feed-design-document.md`. Records decisions,
deferred work, and gotchas discovered while building, so nothing rots silently.

## Build status (by phase, per design §17)

- **Phase 1 — entity-type registration (§16):** DONE. `SUPPORTED_ENTITY_TYPES`
  in `apps/api/src/services/visibility.service.ts` now covers banter.message,
  banter.channel, bearing.goal, bearing.kr, board.board, book.event,
  bill.invoice, blank.form, bolt.rule (plus the pre-existing set). Each has a
  `preflight*` branch mirroring that app's own read rule.
- **Phase 2 — schema + subscriptions + channel-follow (§5/§7):** DONE.
  Migration `0201_banter_feed.sql`; Drizzle in `apps/banter-api/.../feed.ts`;
  shared domain in `packages/shared/src/banter-feed.ts`; subscription CRUD +
  channel-follow alias; per-channel follow/mute control in the channel header.
- **Phase 3 — Banter-only fan-in (§10):** DONE. `banter-feed-fanin` BullMQ job
  in `apps/worker`; banter-api enqueues one job per channel message.
- **Phase 4 — read API + Feed UI (§6/§13):** DONE. Read-time scoring + Redis
  cache; `/v1/feed` + seen/dismiss/permalink; Feed page + button; Feed is the
  default Banter landing.
- **Phase 5 — cross-app fan-in (§11):** Bam + Brief DONE (the §17.5 "first"
  set). Bam: task assignment → `bam.task.assigned_to_me` (direct), comment →
  `bam.task.comment_on_my_task` (direct: assignee/reporter/watchers/prior
  commenters), state change → `bam.task.state_changed` (direct + project
  followers). Brief: create/edit → `brief.document.created`/`edited` (creator +
  collaborators direct, project followers broad). Each app has its own
  `services/feed-queue.ts` producer; the worker's project/source broad
  enumeration is exercised by these. The remaining sources
  (bond/bell/book/bearing/board/bill/blank/bolt) are a mechanical extension —
  see the template below.
- **Phase 6 — unified notifications (§12):** Incremental step DONE; full legacy
  retirement DEFERRED. The fan-in now writes a `notifications` row (the table the
  shared bell already reads) for feed categories whose notification the Feed
  *owns* and that fire for the recipient (§12.1 policy), deep-linked to the feed
  permalink `/banter/feed/:id` (§12.2). To avoid duplicate bell dings it skips
  categories a legacy path still owns (`FEED_NOTIFICATION_LEGACY_OWNED`:
  banter.mention/thread/dm via emitNotification, bam.task.assigned_to_me via
  Bam's enqueueNotification). Net new today: bell dings for task
  comments + state changes, which previously produced none. **Deferred:** folding
  the legacy banter + bam-assignment paths onto the substrate and removing them
  (shrinking the skip set to empty) is the remaining §17.6 migration — it touches
  the shared bell across every app and depends on the mention-resolution fix
  ([[task #76]]), so it's best done as a focused change with the bell observable,
  not bundled here. The pre-existing DM double-notification symptom is part of
  that legacy path and is out of scope until then.
- **Phase 7 — settings pages (§9):** PENDING.

### Extending cross-app fan-in to the remaining sources (the §17.5 tail)

The pattern is identical for every app and proven across Banter/Bam/Brief:

1. Add a `services/feed-queue.ts` to the app (copy `apps/api/src/services/
   feed-queue.ts`), importing `bullmq` (add to package.json if absent),
   `BANTER_FEED_FANIN_QUEUE`, `RELATIONSHIP_FLAGS`, and the job types from
   `@bigbluebam/shared`.
2. At each activity site (co-located with the existing `publishBoltEvent`
   call), fire a fire-and-forget `enqueueFeedFanin({...})` with the entity, the
   org/project, the actor, the producer-resolved `direct_recipients`
   (concerned users + their flags), and `broad_category` / `broad_scope` per the
   §8 / §11 tables. Map each remaining category:
   - `bond.deal.updated` → deal owner; broad `source` (bond).
   - `bell.ticket.updated` → assigned agent + interactors; broad `source` (bell).
   - `book.event.invited` → invitees (direct-only).
   - `bearing.kr.progress` → KR + goal owner; broad `source` (bearing).
   - `bill.invoice.activity` → invoice owner; broad `source` (bill).
   - `blank.form.response` → form owner; broad `source` (blank).
   - `board.canvas_edited` → early contributors only (broad_surface=FALSE).
   - `bolt.run.failed_mine` → the human the run acted for (direct-only).
3. No worker change is needed — `handleFeedFanin` + `enumerateBroadCandidates`
   already handle channel/project/source scopes and any entity_type registered
   in Phase 1.

## Deferred / known-incomplete (revisit, do not let rot)

1. **Live WS push is deferred; the Feed polls every 60s.** §10.2 step 5 calls
   for a `feed.entry.created`/`updated` WS event to `user:{id}` so the Feed
   updates instantly. For now the SPA `useFeed` hook uses `refetchInterval:
   60_000` (mirroring `use-unread`) plus immediate invalidation on the user's
   own seen/dismiss/follow actions. New entries from *other* users' activity
   appear on the next poll (≤60s). Wiring the worker → `banter:user:{id}` WS
   relay is a clean follow-up; the read cache key already keys on the user's
   max `seq`, so a WS nudge would just trigger an earlier refetch.

2. **Re-activity only fans in on message creation.** Reactions and edits on an
   existing message do not yet re-enqueue a fan-in job, so an entry's
   `last_activity_at` / `engagement_count` is set at creation and not bumped by
   later reactions. The "last commented on bumps it up" behavior (§6.1) works
   for thread *replies* (each reply is a new message that enqueues) but not for
   bare reactions. Add a reaction/edit → `enqueueFeedFanin` hook (with the same
   entity_id so the worker's upsert path bumps the existing row) when polishing.

3. **Broad-scope enumeration for project/source is implemented but unexercised.**
   `enumerateBroadCandidates` in the worker handles `channel`, `project`, and
   `source`, but only Banter (channel scope) produces fan-in jobs today. The
   project/source paths light up in Phase 5 when cross-app producers land;
   verify their candidate queries (`project_memberships`,
   `organization_memberships`) against real rows then.

4. **Legacy `banter-notification` path still runs in parallel.** The Feed does
   not yet own notifications; `emitNotification` (direct writes to the
   `notifications` table from banter-api) is untouched. Phase 6 migrates the
   bell onto the Feed substrate and retires the legacy path (§17.6). Until then
   a mention writes both a `notifications` row (legacy) and a feed entry (new).

5. **Read cache is best-effort.** `feed-read.service.ts` caches the scored
   ordering in Redis keyed by `bfeed:{user}:{weightsVersion}:{maxSeq}` with a
   60s TTL, busted on seen/dismiss via SCAN. Every failure mode (Redis down,
   miss, parse error) falls through to fresh scoring, so correctness never
   depends on the cache. At 2–50-user scale fresh scoring is sub-millisecond;
   the cache is a latency optimization, not a correctness requirement.

## Gotchas

- **Banter visibility is membership-gated for ALL channel types.** `can_access`
  for banter.message/banter.channel mirrors `requireChannelMember`: even a
  *public* channel requires membership to read content (non-members 403),
  SuperUsers bypass, archived channels are hidden to non-SU, and non-member org
  admins are NOT elevated (the P2-15 finding). A consequence: @mentioning
  someone who is not in the channel drops their *feed* entry (they cannot read
  the message) even though the legacy notification path still notifies them.
- **DMs never enter the Feed (§12.2).** The fan-in producer skips `dm` /
  `group_dm` channels; DM notifications route to the DM view.
- **The host-side `pnpm db:check` cannot reach Postgres** (the container's 5432
  is not published). CI runs it against a reachable container; locally, verify
  new tables/columns by dumping `information_schema.columns` via
  `docker compose exec postgres psql`.

## 2026-06-18 — surface-everything-visible, relevance boosts, inline interaction

Three changes (feed-read.service.ts + feed.tsx), all live-verified on the
Gilligan stack.

- **"Surface everything visible" == every channel you can READ.** The backfill
  was widened to top up from all of a user's channels (public + private) and
  re-runs on a throttle (`BACKFILL_THROTTLE_SECONDS = 180`) for populated feeds,
  not only when empty — so a channel you JOIN later flows in (with recent
  history) within a few minutes. **It is intentionally scoped to channels the
  user is a member of.** A first cut also surfaced *unjoined public* channels,
  but `requireChannelMember` (apps/banter-api/src/middleware/channel-auth.ts:108)
  returns **403 to a non-member even of a public channel** — reading a public
  channel's messages requires joining it. Surfacing unjoined public channels
  therefore leaked previews of unreadable messages, so it was reverted.

- **DONE (2026-06-18) — public channels are org-readable.** Public channels can
  now be read AND posted to by any member of the org without joining, so the Feed
  surfaces them (Facebook-style discovery). Two mirrored gates changed:
  `requireChannelMember` (apps/banter-api/src/middleware/channel-auth.ts)
  synthesizes a non-admin context for a non-member on a public channel (private
  still 404s non-members), and `banterChannelAccess` in
  apps/api/src/services/visibility.service.ts returns allowed for a public
  channel in the asker's org. **No auto-join** — joining the sidebar stays an
  explicit action; the followed/unfollowed subscription controls Feed presence.
  Admin actions remain gated (the synthesized 'member' role does not satisfy
  `requireChannelAdmin`; P2-15 non-elevation still holds). The Feed sources all
  public channels (backfill + fan-in Path B now enumerate org members for public
  channels), each vetoable via unfollow/mute. A channel is followed by default;
  unfollow from the channel header (ChannelFollowButton) or the feed-card
  overflow (⋯) menu.

- **Relevance boosts now computed (were hardcoded 0).** `enrichBoostFlags` in
  feed-read.service.ts computes the viewer's flags on the scored candidate page
  at READ time (so "I already commented" stays correct as the user interacts;
  the 60s ordering cache bounds re-rank latency): COMMENTED/COMMENTER from
  `banter_messages.reply_user_ids` (membership tested in JS — the SQL
  `${id}::uuid = ANY(col)` bound-param form silently matches nothing under
  postgres.js), and ASSIGNEE / AUTHOR+AUTHORED from `tasks.assignee_id` /
  `tasks.reporter_id`. It is applied in BOTH getOrderedRefs (for ordering) and on
  the re-fetched page rows in getRankedFeed (so the explain breakdown matches the
  ordering score), and is wrapped best-effort so a failure degrades to "no boost"
  rather than breaking the read. The "tagged" boost is NOT recomputed here — live
  @mentions already arrive as boosted `banter.mention` entries via the fan-in
  (category W=3.0 + must_see_floor); a mentions table does not exist (see the
  @mention resolution note / display_name-vs-handle ambiguity), so historical
  backfilled mentions land as plain channel_post.

- **Inline interaction (feed.tsx).** `banter.message` cards gained an expandable
  thread (read replies via `useThreadReplies`), an inline reply composer
  (`usePostThreadReply` → POST /v1/messages/:id/thread), and a 👍 react
  (`useToggleReaction`) — reusing the channel view's existing hooks/endpoints, no
  new API. The hydrated entry now exposes `root_entity_id` + `channel_slug` so the
  card can drive the thread. Replying invalidates `['feed']` so the engagement
  count and the now-earned COMMENTED boost refresh. Non-banter entries keep
  open-in-app.

- **Scaling note (write amplification).** The throttled top-up runs one
  INSERT...SELECT over the user's channels' 30-day window per active user per
  ~3min; the materialized-per-user index is O(users × messages). Fine at the
  2-50-user target; if a deployment grows, move the top-up off the read path
  (fire-and-forget for populated feeds) or shorten the window.
