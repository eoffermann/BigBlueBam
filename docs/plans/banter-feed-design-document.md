# Banter Feed — Design Document

Status: DRAFT — awaiting review.
Date: 2026-06-18.
Branch: `banter-feed` (proposed).
Scope: a new ranked, top-down view *inside* Banter. Not a new B-product, not a new app, not a new port. It reuses `banter-api` (:4002), the Banter SPA, and the existing cross-app activity substrate.

---

## 1. What this is, in one paragraph

Banter Feed is a single, ranked, top-down stream that shows a user everything across BigBlueBam that might interest them right now: posts in channels they follow, replies on threads they are part of, and cross-app activity that concerns them (a task assigned to them, a comment on that task, a Brief they helped write getting edited, a Helpdesk ticket they touched getting a reply). Most recently active content floats to the top, with a strong weighting toward publish recency, and content the user has personally interacted with ranks above content they have not. It becomes the default view when you open Banter, and a **Feed** button near the upper-left of the Banter chrome takes you back to it from Channels or DMs.

The important architectural claim, and the thing that makes this worth building rather than bolting on yet another notifications widget: **Feed and unified notifications are two renderings of one substrate.** A notification is a Feed entry that also earned a bell ding. The Feed is the continuous, ranked, browsable view of the same entries. Build the substrate once and both fall out of it. This also finally delivers the unified-notifications goal that the Banter UI alignment plan flagged as desired but unresolved.

---

## 2. Where it lives (and what it does *not* add)

Banter Feed is a feature of Banter. It does not get its own single-word B name (it is a view, like Channels or DMs), its own SPA, its own container, or its own port. Concretely:

- **API:** new routes under the existing `banter-api` service (internal :4002, proxied at `/banter/api/`). No new Fastify app.
- **Worker:** new BullMQ job handlers in the existing `apps/worker` process, alongside the current `banter-notification` and `banter-retention` jobs.
- **SPA:** new pages and components inside `apps/banter`. The Feed is rendered client-side and routed at `/banter/feed`.
- **nginx:** no new upstream. One new client-side route (`/banter/feed`, `/banter/feed/:entryId`) served by the existing Banter SPA static handler. Nothing changes in `nginx.conf` because the SPA already catches all `/banter/*` paths and routes them client-side.
- **WebSocket:** reuses the existing Banter WS at `/banter/ws` with new event names.

The only genuinely new infrastructure is three database tables (all `banter_` prefixed), a worker fan-in job, and a small set of MCP tools. That is deliberate. The whole point of the shared-PostgreSQL, agents-as-first-class-users architecture is that a feature like this is mostly wiring, not a new stack.

---

## 3. The substrate: Feed entries as a per-user candidate index

A **feed entry** is a per-user candidate row that points at an underlying entity (a Banter message, a Bam task, a Brief document, a Helpdesk ticket, and so on) and carries the metadata needed to rank it. The entry table is a lightweight index, not a copy of the content. Content is hydrated at read time from the owning app.

The scoring decision is **computed at read time** from the current effective weights, not baked into the row at write time. This matters: when you (or an org admin) change a category weight, the change takes effect on the next feed read, with no recompute job and no stale scores. The write path only maintains *which* entries exist and *when they were last active*. The read path does the ranking. For a 2-to-50-person team the candidate set per user is small (hundreds to low thousands of live entries), so read-time scoring with a Redis cache is cheap and keeps the tuning loop instant. That tight tuning loop is exactly what you asked for: a place to vary weights and watch the feed respond.

This is a hybrid of the two obvious designs. Pure fan-out-on-write (materialize a fully-ranked feed per user on every event) is wrong here because it forces a recompute storm every time a weight changes and every time an hour passes (recency decays continuously). Pure query-time assembly (no index, scan every app's tables on every feed load) is wrong because the candidate-gathering query would fan across eight apps on every page load. The hybrid keeps a cheap append/upsert index for membership and freshness, and ranks on read.

---

## 4. Inclusion model: why an entry exists at all

Before anything gets ranked, it has to qualify for the user's feed. There are exactly two paths in, plus one hard gate and one hard veto.

### 4.1 The hard gate: `can_access`

Every cross-app entity surfaced into a user's feed MUST pass `can_access(user_id, entity_type, entity_id)` (the Wave 2 visibility preflight). The feed is per-user, so the asker is always the viewer, which makes this straightforward, but it is non-negotiable. If the preflight returns anything other than `ok`, the entry is dropped, never created. "Bob created a new Brief" only reaches you if `can_access` says you can see that Brief.

This has a concrete prerequisite, covered in §16: several of the entity types the Feed wants to surface are not yet in `SUPPORTED_ENTITY_TYPES`. Those branches have to land first, or the feed denies-by-default and silently shows nothing from those sources.

### 4.2 Path A — Direct relationship (surfaces regardless of follow state)

If the user has a direct relationship to the entity, it surfaces. Direct relationships:

- assigned to you (task, ticket, KR owner)
- you authored or contributed to it (you are an author/collaborator on the Brief, an early contributor on the Board, the channel post author, a previous commenter on the thread)
- you commented on it or reacted to it
- you are a watcher
- you were @mentioned
- an approval/proposal is awaiting your decision (the HITL inbox)

Direct items are the spine of the feed. They are why the Board example resolves the way you described: a random person editing a drawing does not hit your feed, but a drawing **you were an early author or contributor on** does, because that is a direct relationship. The broad "someone touched a Board" path is off by default for canvas edits (see §8 category policy), so the only way a Board edit reaches you is the direct path.

### 4.3 Path B — Followed scope (surfaces only if you follow the scope and the category allows broad surfacing)

If you do not have a direct relationship, the entry still surfaces when both of these hold:

1. You follow the scope it belongs to (the channel, the project, or the whole app/source), per the subscription hierarchy in §5, and
2. The category permits broad surfacing (`broad_surface = true`).

This is the path that delivers "Bob created a new Brief titled ___" to people who follow that project or the Brief source and have access, and the path that surfaces ordinary channel chatter to channel followers. It is also the path that is **off** for noisy categories like Board canvas edits, so following Board does not drown you in every stroke.

### 4.4 The hard veto: mute

A mute on a scope suppresses everything from that scope, including direct-relationship items. Mute is the strong opt-out. It is distinct from unfollow (see §5.3): unfollow turns off Path B but leaves Path A intact, mute turns off both. You can mute or unfollow any source, project, channel, or individual item at any time, which is the "opt out of notifications from any particular source at any time" requirement, made precise.

### 4.5 The decision, as pseudocode

```text
function shouldSurface(event, user):
    entity = event.entity
    if not can_access(user.id, entity.type, entity.id).allowed:
        return DROP                         # hard gate

    sub = resolveSubscription(user, entity) # most-specific scope wins (§5.2)
    if sub.state == 'muted':
        return DROP                         # hard veto

    rel = classifyRelationship(event, user) # DIRECT | NONE
    if rel == DIRECT:
        return INCLUDE                      # Path A

    if sub.state == 'following' and categoryPolicy(event.category).broad_surface:
        return INCLUDE                      # Path B

    return DROP
```

`classifyRelationship` is the cross-app generalization of the existing Bam notification-trigger table (assignee, watcher, mentioned, commenter, and so on). It is the same "concerned users" resolution that drives notifications today, lifted to span every app.

---

## 5. Subscriptions: the follow/mute hierarchy

### 5.1 Default-on, store only deviations

Surfacing into Banter is a default, as you said. So the model is **default-on with explicit opt-out rows**. We do not write a "follow" row for every channel you join or every project you are added to. The absence of a row means "use the effective default," and the default is `following`. The only rows we store are deviations: an `unfollowed` or `muted` state at some scope. This keeps the table tiny (it grows with opt-outs, not with memberships) and matches the mental model that you are opted in until you say otherwise.

Channel auto-follow-on-join, which you called out specifically, is just this default expressing itself: join a channel, no row exists, effective state is `following`, you see the channel in your feed. Opt out and we write one `unfollowed` (or `muted`) row. Leave the channel and we clean up any row for it.

### 5.2 Scope precedence (most specific wins)

A subscription targets a scope. Scopes, from most specific to least:

1. `item` — a single entity (this one Brief, this one task, this one board)
2. `channel` — a Banter channel
3. `project` — a Bam project (and everything linked under it)
4. `source` — a whole app: `banter`, `bam`, `brief`, `beacon`, `board`, `bond`, `bell` (Helpdesk), `book`, `bill`, `bearing`, `blank`, `bolt`

Effective state for an entity is resolved by walking from most specific to least specific and taking the first explicit row found; if none exists, fall back to the configured default (normally `following`). So you can unfollow the `board` source entirely but still `follow` one specific board you care about (an `item` row overrides the `source` row), or follow `brief` broadly but `mute` one noisy document.

### 5.3 Three states

| State | Path A (direct) | Path B (followed-scope broad) | Meaning |
|---|---|---|---|
| `following` | on | on | Default. Surfaces direct items and broad items from this scope. |
| `unfollowed` | on | off | Soft opt-out. "Stop showing me general activity here, but still tell me when something concerns me directly." |
| `muted` | off | off | Hard opt-out. "I do not want anything from this scope, even things assigned to me." |

`unfollowed` is the sensible default opt-out and what the per-item "unfollow this project / this app" affordance writes. `muted` is the heavier hammer for sources a user genuinely never wants to hear about. Defaulting the UI's primary opt-out to `unfollowed` (not `muted`) protects people from accidentally hiding their own assigned work.

### 5.4 Table: `banter_feed_subscriptions`

```sql
CREATE TABLE banter_feed_subscriptions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type    varchar(16) NOT NULL,   -- 'item' | 'channel' | 'project' | 'source'
    scope_source  varchar(16) NOT NULL,   -- which app: 'banter','bam','brief',... (the source for any scope)
    scope_id      uuid,                    -- entity/channel/project id; NULL for scope_type='source'
    state         varchar(12) NOT NULL DEFAULT 'following', -- 'following' | 'unfollowed' | 'muted'
    origin        varchar(8)  NOT NULL DEFAULT 'manual',    -- 'manual' | 'auto'
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX banter_feed_subs_unique
    ON banter_feed_subscriptions (user_id, scope_type, scope_source, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX banter_feed_subs_lookup
    ON banter_feed_subscriptions (user_id, scope_source, scope_type);
```

(We only ever write rows here for `unfollowed`/`muted`, plus the rare explicit re-`following` row that overrides a broader opt-out. `following` rows are not written for the default case.)

---

## 6. The ranking algorithm

### 6.1 "Newest" is the later of posted and last-active

You defined newest as a combination of when something was posted and when it was last commented on. The entry tracks both, and recency keys off the later one:

```text
effective_time = max(published_at, last_activity_at)
```

For a Banter channel post, `last_activity_at` is bumped by thread replies and reactions on that post. For a Bam task, it is bumped by comments, state changes, and reassignments. For a Brief, by edits and comments. This is exactly what the unified activity log already records, so the worker just reads it.

### 6.2 The score

For each candidate entry `i` and viewer `u`:

```text
age_hours   = (now - effective_time_i) / 3600
recency_i   = 1 / (age_hours + recency_offset)^gravity              # Hacker-News-style decay

W_i         = category_weight[ category_i ]                         # tunable, platform/org (§8)
affinity_i  = sum of affinity_boost[r] for each direct relationship r the viewer has to i
interact_i  = sum of interaction_boost[k] for each past interaction k the viewer made on i
engage_i    = log1p(comment_count + reaction_count + distinct_participants)   # social proof

score_i = W_i
        * recency_i
        * (1 + affinity_i + interact_i)
        * (1 + engagement_weight * engage_i)
        * seen_multiplier_i                                          # 1.0 unseen, <1 once seen
```

Dismissed entries are excluded entirely (not down-weighted). Seen-but-not-dismissed entries get a `seen_multiplier` below 1 so they sink over time without vanishing, which keeps the feed from re-shouting the same item at you while still letting an item resurface if it gets hot again (a new reply bumps `effective_time`, which lifts `recency_i` back up).

Two synthetic "must-see" categories get an additive floor on top of the multiplicative score so they pin to the top regardless of age: an unresolved approval/proposal awaiting your decision, and an unread direct @mention. Everything else competes purely on the multiplicative score.

### 6.3 Candidate window and caching

Read-time scoring runs over a bounded candidate set: entries with `effective_time` within the last 30 days (configurable) and not dismissed, capped at a generous ceiling per user. The scored, ordered result is cached in Redis keyed by `(user_id, weights_version, last_entry_seq)` with a short TTL (about 60 seconds). The cache is busted when a new entry lands for the user (WS push also fires), when the user marks something seen/dismissed, or when the effective weights version changes. `weights_version` is a monotonic integer bumped on any platform or org weight write, so a weight change invalidates every affected cache key immediately. This is why tuning feels live.

---

## 7. Data model (entries and weights)

### 7.1 Table: `banter_feed_entries`

```sql
CREATE TABLE banter_feed_entries (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category          varchar(48) NOT NULL,     -- §8 taxonomy, e.g. 'banter.channel_post'
    entity_type       varchar(48) NOT NULL,     -- canonical entity_type, e.g. 'brief.document'
    entity_id         uuid NOT NULL,
    root_entity_type  varchar(48),              -- for grouping (thread root, parent task); NULL = self
    root_entity_id    uuid,
    source            varchar(16) NOT NULL,     -- owning app for subscription resolution
    channel_id        uuid,                     -- when applicable (banter); NULL otherwise
    project_id        uuid,                     -- when applicable (bam-linked); NULL otherwise
    published_at      timestamptz NOT NULL,
    last_activity_at  timestamptz NOT NULL,
    relationship_flags integer NOT NULL DEFAULT 0,  -- bitset: assignee, author, watcher, mentioned, commenter, reactor, approver
    interaction_flags  integer NOT NULL DEFAULT 0,  -- bitset of the viewer's own past interactions
    engagement_count   integer NOT NULL DEFAULT 0,  -- denormalized comment+reaction+participant tally
    seen_at           timestamptz,
    dismissed_at      timestamptz,
    seq               bigserial,                -- per-org monotonic for cache keys / cursoring
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX banter_feed_entries_unique
    ON banter_feed_entries (user_id, entity_type, entity_id);
CREATE INDEX banter_feed_entries_ranking
    ON banter_feed_entries (user_id, last_activity_at DESC)
    WHERE dismissed_at IS NULL;
CREATE INDEX banter_feed_entries_seq
    ON banter_feed_entries (org_id, seq DESC);
```

One row per `(user, entity)`. The fan-in job upserts: first time the entity becomes relevant to the user it inserts; subsequent activity updates `last_activity_at`, `engagement_count`, and the flag bitsets. Relationship and interaction flags are stored (not recomputed on read) because they only change on discrete events, unlike recency.

### 7.2 Table: `banter_feed_weights`

Two-level settings, platform and org, stored as JSONB weight sets. Effective weights are a deep merge of the platform row under the org row.

```sql
CREATE TABLE banter_feed_weights (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope       varchar(8) NOT NULL,          -- 'platform' | 'org'
    org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL for platform
    weights     jsonb NOT NULL,               -- partial or full weight set; org rows hold only overrides
    version     integer NOT NULL DEFAULT 1,   -- bumped on write; feeds the cache key
    updated_by  uuid REFERENCES users(id),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX banter_feed_weights_platform ON banter_feed_weights (scope) WHERE scope = 'platform';
CREATE UNIQUE INDEX banter_feed_weights_org      ON banter_feed_weights (org_id) WHERE scope = 'org';
```

Resolution: `effectiveWeights(org) = deepMerge(PLATFORM_DEFAULTS, platformRow.weights, orgRow.weights)`. `PLATFORM_DEFAULTS` is a code constant (the table below) so a fresh install has sane behavior before anyone touches the settings page. The platform row overrides the code default deployment-wide; the org row overrides for that org. `weights_version` used in the Redis cache key is `platformRow.version * 1e6 + orgRow.version` so either level bumping invalidates correctly.

---

## 8. Category taxonomy and default weights

Each category carries: a base weight `W`, a `broad_surface` policy bit (does Path B apply, or is this direct-only), and a `notification_policy` (§12). Defaults below are starting values, meant to be refined against real feeds, exactly as you described.

| Category | `W` | `broad_surface` | `notification_policy` | Notes |
|---|---|---|---|---|
| `approval.awaiting_me` | 3.0 | n/a (always direct) | always | HITL proposal needs your decision. Additive floor → top. |
| `mention.cross_app` | 2.8 | n/a (direct) | always | @mention in any app. Additive floor when unread. |
| `banter.mention` | 3.0 | n/a (direct) | always | @mention in a channel/thread. |
| `bam.task.assigned_to_me` | 2.5 | n/a (direct) | always | New assignment. |
| `bam.task.comment_on_my_task` | 2.2 | n/a (direct) | direct_only | Comment on a task you own/report/watch. |
| `banter.thread.reply` | 1.8 | true | direct_only | Reply on a thread you are in. |
| `bell.ticket.updated` | 1.8 | true | direct_only | Helpdesk ticket you touched/were assigned, or you follow `bell`. Links to the ticket, or the linked task if an entity-link exists. |
| `bam.task.state_changed` | 1.6 | true | direct_only | State/phase change on a task you relate to. |
| `beacon.entry.activity` | 1.6 | true | direct_only | Comment/link on a Beacon entry you contributed to. |
| `book.event.invited` | 1.5 | true | always | You were invited to an event. |
| `brief.document.edited` | 1.5 | true | never | Edit on a doc you contributed to (direct), or broad if you follow the project/source. |
| `bolt.run.failed_mine` | 1.5 | n/a (direct) | always | An automation acting on your behalf failed. |
| `bond.deal.updated` | 1.4 | true | never | Deal you own changed. |
| `bearing.kr.progress` | 1.3 | true | never | KR you own had a progress update. |
| `banter.channel_post` | 1.2 | true | never | New post in a channel you follow. The bread and butter of Path B. |
| `bill.invoice.activity` | 1.2 | true | never | Invoice concerning you. |
| `brief.document.created` | 1.0 | true | never | "Bob created a new Brief titled ___" to project/source followers with access. |
| `board.canvas_edited` | 1.0 | **false** | never | Board edits surface ONLY via the direct path (early author/contributor). Following Board does not flood you with edits. |
| `blank.form.response` | 0.9 | true | never | New response on a form you own. |
| `source.generic_activity` | 0.8 | true | never | Catch-all for followed-source activity without a more specific category. |
| `banter.dm` | 2.5 | n/a | always (routes to DM, not Feed) | See §12.2. Does **not** create a Feed entry by default. |

Global knobs (the dials, not the per-category weights):

| Knob | Default | Effect |
|---|---|---|
| `gravity` | 1.5 | Recency decay exponent. Higher = newer content dominates harder. |
| `recency_offset` | 2.0 (hours) | Dampens the brand-new spike and avoids divide-by-zero. |
| `engagement_weight` | 0.15 | How much social proof (replies/reactions/participants) lifts an item. |
| `interaction_boost.commented` | 0.6 | You commented on it. |
| `interaction_boost.reacted` | 0.3 | You reacted to it. |
| `interaction_boost.authored` | 0.8 | You authored it. |
| `interaction_boost.mentioned` | 0.7 | You were mentioned in it. |
| `affinity_boost.assignee` | 0.8 | It is assigned to you. |
| `affinity_boost.watcher` | 0.4 | You watch it. |
| `affinity_boost.contributor` | 0.5 | You are an early author/contributor. |
| `seen_multiplier` | 0.4 | Multiplier applied once an entry is seen (sinks, does not vanish). |
| `candidate_window_days` | 30 | How far back the candidate scan reaches. |
| `must_see_floor` | 1000 | Additive floor for `approval.awaiting_me` and unread direct mentions. |

All of the above live in the `weights` JSONB and are editable at both levels. Nothing here is hardcoded past the `PLATFORM_DEFAULTS` constant that seeds a fresh install.

---

## 9. Settings: Platform and Organization

You asked for a settings page at both levels. Both edit the same shape (the weights JSONB); they differ in scope and who can touch them.

**Platform level (SuperUser only).** Edits the `scope='platform'` row. This is the deployment-wide default that every org inherits unless it overrides. Surfaced in the Banter admin area, gated by `requireSuperUser` (the same plugin `banter-api` already uses). Writes bump `version` and append to `banter_audit_log` with `action='feed.weights.platform_updated'`. The UI is a form bound to every category weight and every global knob, with a "reset to shipped defaults" affordance and a live preview panel that re-scores the editor's own feed against the proposed weights (a dry-run read that does not persist).

**Organization level (org owner/admin).** Edits the `scope='org', org_id=<org>` row, which holds only the deltas from the platform defaults. Surfaced in Banter Settings under a new "Feed" tab, gated by `requireMinRole('admin')`. Same form, same live preview, plus a clear indicator of which values are org overrides versus inherited-from-platform. Writes bump that org's `version` and append `action='feed.weights.org_updated'` to `banter_audit_log`.

Both forms group the controls sensibly: "What floats to the top" (per-category weights), "How fast things age out" (gravity, offset), "How much your own activity matters" (interaction/affinity boosts), "How much the crowd matters" (engagement weight). The point of the preview is the refinement loop: change a number, watch your own feed reshuffle, commit when it feels right.

A note on individual users versus org/platform settings: the per-user follow/mute controls (§5) are not in these weight pages. Those are the user's own opt-outs, lived in `banter_feed_subscriptions`, and exposed inline in the feed and in a per-user Feed preferences panel. Weights are administrative tuning; subscriptions are personal curation. Keeping them separate avoids the trap of users thinking they can reweight the algorithm (they can only opt in and out of sources).

---

## 10. Event ingestion (the fan-in job)

### 10.1 Where the events come from

The platform already emits a normalized event stream. Every app publishes to the Bolt event bus (the `publishBoltEvent` path, per D-007/D-008), and writes to the partitioned `activity_log` with `actor_type ∈ {human, agent, service}`. The unified activity reads (`activity_query`, `activity_by_actor`) already expose this cross-app. Banter Feed does not invent a new event source; it subscribes to the one that exists.

### 10.2 The job

A new BullMQ job `banter-feed-fanin` in `apps/worker/src/jobs/` consumes platform activity events (via the same Redis stream/queue the Bolt and notification paths use) and, for each event:

1. Classify the event into a Feed `category` (§8).
2. Resolve the set of **concerned users** (the cross-app generalization of the Bam notification-trigger table: assignee, reporter, watchers, mentioned, previous commenters/reactors, doc collaborators, board early-contributors, approval recipients, plus followers of the relevant scope when `broad_surface` is true).
3. For each concerned user, run `shouldSurface` (§4.5): `can_access` gate, subscription resolution, relationship classification.
4. For survivors, upsert `banter_feed_entries` (insert on first relevance; otherwise bump `last_activity_at`, `engagement_count`, and the flag bitsets).
5. Bust the user's Redis feed cache and emit a `feed.entry.created` / `feed.entry.updated` WS event to `user:{id}`.
6. If the category's `notification_policy` fires for this user/relationship (§12), enqueue the notification.

This is one job doing both feed maintenance and notification dispatch, because they are the same substrate. The existing `banter-notification` job is folded into this path over time (it remains for legacy in-Banter unread until the migration completes; see build order §17).

### 10.3 Backfill and retention

A one-shot backfill seeds the candidate index from the last `candidate_window_days` of `activity_log` so the feed is not empty on first deploy. The existing `banter-retention` job is extended to prune `banter_feed_entries` past the window (dismissed entries can be pruned sooner). Entries are cheap and per-user; pruning is a windowed `DELETE` on `(user_id, last_activity_at)`.

---

## 11. Concerned-users resolution (the cross-app trigger table)

This generalizes the Bam notification triggers across every app. It is the single most important piece of logic to get right, because it decides who hears about what.

| Event | Direct-relationship recipients (Path A) | Broad recipients (Path B, if `broad_surface`) |
|---|---|---|
| Banter channel post created | author; @mentioned users | followers of the channel |
| Banter thread reply | thread participants; root author; @mentioned | followers of the channel |
| Bam task assigned | new assignee | followers of the project |
| Bam task comment | assignee; reporter; watchers; prior commenters; @mentioned | followers of the project |
| Bam task state change | assignee; reporter; watchers | followers of the project |
| Brief document created | collaborators named at creation | followers of the linked project or `brief` source |
| Brief document edited | authors/collaborators | followers of the linked project or `brief` source |
| Brief comment | thread participants; doc collaborators; @mentioned | followers of the linked project or `brief` source |
| Beacon entry comment/link | entry author/contributors; @mentioned | followers of the linked project or `beacon` source |
| Board canvas edited | early authors/contributors of that board | (none — `broad_surface=false`) |
| Helpdesk ticket update | assigned agent; users who interacted with the ticket or its linked task | followers of `bell` source |
| Book event invite | invitees | (none — invite is inherently direct) |
| Bond deal update | deal owner | followers of `bond` source |
| Bill invoice activity | invoice owner; named contacts mapped to users | followers of `bill` source |
| Bearing KR progress | KR owner; goal owner | followers of `bearing` source |
| Blank form response | form owner | followers of `blank` source |
| Bolt run failed | the human the run acted on behalf of | (none) |
| Approval/proposal created | the designated approver(s) | (none) |

The Board and Helpdesk rows are the two you called out, encoded exactly: Board edits reach you only as an early contributor, and a Helpdesk ticket update reaches you if you are assigned, have interacted with the ticket or its linked task, or follow Helpdesk, with the entry preferring the linked-task permalink when an entity-link exists.

---

## 12. Unified notifications

### 12.1 One substrate, two surfaces

Notifications are not a separate system. A notification is a Feed entry whose category `notification_policy` fired for this user. The bell badge counts unseen entries with a fired notification; the notification dropdown is a filtered view of recent fired entries; the Feed is the full ranked stream. This is the unified-notifications model the alignment plan wanted, and it means there is exactly one "concerned users" resolution and one place to opt out.

`notification_policy` per category (column in §8):

- `always` — fires for every recipient (direct or broad). Used sparingly: mentions, assignments, approvals, event invites, failed automations.
- `direct_only` — fires only for Path A recipients. The broad followers get a Feed entry but no ding.
- `never` — populates the Feed, never dings. Most ambient activity.

A user's mute/unfollow (§5) suppresses notifications the same way it suppresses feed entries, because it suppresses the entry itself. That is the "opt out of any source at any time" guarantee, and it is automatic rather than a second set of notification preferences to maintain.

### 12.2 Link routing (your rule, encoded)

The notification's deep link is decided by category:

- **DM** → links straight to the DM in Banter (`/banter/dm/:channelId`). DMs do **not** create a Feed entry by default; they are handled by the DM list plus a notification that opens the DM. (DMs are private 1:1/group threads; duplicating them into a public-ish ranked feed adds noise and a second place to manage them. The notification-to-DM path is the right surface. This is a fork if you disagree, see §18.)
- **Everything else that lives in the Feed** → links to the Feed permalink `/banter/feed/:entryId`, which opens the Feed scrolled-to and focused on that entry, with a secondary "open in {source app}" action on the entry itself. So clicking a "Bob edited the Brief" notification lands you in the Feed at that item, and from there one more click opens the Brief.

This gives the consistent behavior you described: DM notifications take you to the DM, and everything that is reflected in Banter Feed takes you to its place in the Feed.

### 12.3 Reuse of the existing `notifications` table

The existing `notifications` table (`user_id`, `type`, `payload jsonb`, `is_read`) is the dispatch record. The fan-in job writes a row here when `notification_policy` fires, with `payload` carrying `{ feed_entry_id, deep_link, category, entity_type, entity_id }`. The Banter header bell reads it (replacing the current `useUnreadCounts`-only path with a unified source, as the alignment plan proposed). No schema change to `notifications` is required; this is additive use of an existing table.

---

## 13. REST API (banter-api, `/banter/api/`)

All routes are session- or API-key-authenticated through the existing `banter-api` auth plugin. Org scope comes from the session `active_org_id`.

| Method + path | Description | Auth |
|---|---|---|
| `GET /v1/feed` | Ranked feed for the caller. Query: `?cursor`, `?limit` (default 30, max 100), `?category`, `?source`, `?unseen=true`. Returns scored, hydrated entries with `score_breakdown` omitted unless `?explain=true`. | requireAuth |
| `POST /v1/feed/seen` | Mark entries seen. Body: `{ entry_ids: [...] }` or `{ before_seq: n }`. | requireAuth |
| `POST /v1/feed/:entryId/dismiss` | Dismiss a single entry (excludes from future reads). | requireAuth |
| `GET /v1/feed/:entryId` | Single entry, hydrated, for the permalink view. | requireAuth |
| `GET /v1/feed/subscriptions` | List the caller's explicit subscription rows (opt-outs). | requireAuth |
| `PUT /v1/feed/subscriptions` | Upsert a subscription. Body: `{ scope_type, scope_source, scope_id?, state }`. This is the "unfollow this project / mute this app / follow this one board" write. | requireAuth |
| `DELETE /v1/feed/subscriptions/:id` | Remove an explicit row (revert to default). | requireAuth |
| `GET /v1/feed/weights` | Effective merged weights for the caller's org (read-only view for the preview panel and clients). | requireAuth |
| `PUT /v1/feed/weights/org` | Upsert the org weight overrides. Bumps org `version`, audits. | requireMinRole('admin') |
| `PUT /v1/feed/weights/platform` | Upsert the platform default weights. Bumps platform `version`, audits. | requireSuperUser |
| `POST /v1/feed/weights/preview` | Dry-run: re-score the caller's feed against a proposed weight set without persisting. Powers the live preview. | requireAuth (admin/SU for the editing surfaces) |

Channel follow, as a convenience alias over subscriptions (so the Banter channel UI does not need to know about the generalized scope model):

| Method + path | Description |
|---|---|
| `GET /v1/channels/:id/follow` | Effective follow state for the caller (resolves default + rows). |
| `PUT /v1/channels/:id/follow` | Set `following` / `unfollowed` / `muted` for the channel (writes a `scope_type='channel'` row). |

---

## 14. MCP tools (`banter_feed_*`)

Following the `banter_` naming convention. Agents are first-class users (§15), so an agent can read its own feed to catch up on what concerns it.

| MCP tool | REST backing | Description |
|---|---|---|
| `banter_feed_query` | `GET /v1/feed` | Ranked feed for the caller (or, for a service account acting on behalf of a user, that user). Supports category/source filters and `explain`. |
| `banter_feed_mark_seen` | `POST /v1/feed/seen` | Mark entries seen. |
| `banter_feed_dismiss` | `POST /v1/feed/:id/dismiss` | Dismiss an entry. |
| `banter_feed_explain` | `GET /v1/feed/:id?explain=true` | Return the full score breakdown for one entry (recency, weight, affinity, interaction, engagement, multipliers). For tuning and debugging. |
| `banter_feed_subscription_set` | `PUT /v1/feed/subscriptions` | Follow/unfollow/mute a scope. |
| `banter_feed_subscription_list` | `GET /v1/feed/subscriptions` | List explicit opt-outs. |
| `banter_feed_weights_get` | `GET /v1/feed/weights` | Effective org weights. |
| `banter_feed_weights_set_org` | `PUT /v1/feed/weights/org` | Set org overrides (admin). |

Platform weight writes stay UI/SuperUser-only and are deliberately not given an MCP tool, matching the convention that SuperUser break-glass surfaces are not agent-exposed.

---

## 15. Agents as first-class users

Agents hold standard roles, so they get feeds for free. An agent assigned a task, mentioned in a channel, or designated as an approver accrues `banter_feed_entries` exactly as a human would, gated by the same `can_access` preflight and the same subscription model. This is useful: an agent runner coming online can call `banter_feed_query` to see what changed in its world rather than polling every app. Agent feed reads honor the agent's own visibility, never the asker's, because the agent is the viewer. No special-casing; the substrate already treats agents and humans identically.

---

## 16. Prerequisite: entity-type registration

This is the recurring integration tax, and it bites here. The Feed surfaces entities from across the suite, and every cross-app entity passes `can_access`, which only covers the Wave 2 `SUPPORTED_ENTITY_TYPES`: `bam.task`, `bam.project`, `bam.sprint`, `helpdesk.ticket`, `bond.deal`, `bond.contact`, `bond.company`, `brief.document`, `beacon.entry`. Anything else returns `unsupported_entity_type` and the Feed will (correctly) deny-by-default, which means those sources silently show nothing.

To surface the categories in §8, these entity types must be registered in `SUPPORTED_ENTITY_TYPES` (in `apps/api/src/services/visibility.service.ts`) with `can_access` preflight branches mirroring each app's own visibility predicate, before or alongside the Feed work:

- `banter.message`, `banter.channel` (channel membership / public-in-org)
- `bearing.goal`, `bearing.kr`
- `board.board` (room membership / org visibility)
- `book.event`
- `bill.invoice`
- `blank.form`
- `bolt.rule` (for failed-run entries)

This is the Wave 3 extension the agent-conventions doc already forward-points to. The Feed is the forcing function for it. Treat "register these entity types" as workstream zero; without it, the cross-app half of the feed is dark. Categories whose entity type is not yet registered should be feature-flagged off rather than shipped broken.

---

## 17. Build order

Phased so each step lands and can be reviewed independently, and so the cross-app surface lights up incrementally rather than all at once.

1. **Entity-type registration (§16).** Extend `SUPPORTED_ENTITY_TYPES` with `can_access` branches for the new types. No Feed code yet; this is plumbing the rest depends on.
2. **Schema + subscriptions.** Migrations for the three tables. Implement the subscription resolution service and the channel-follow alias. Ship the per-channel follow/mute UI affordance first, since it stands alone and is immediately useful.
3. **Fan-in for Banter-only categories.** `banter-feed-fanin` job consuming Banter events (channel posts, thread replies, mentions). Feed renders Banter content only. This proves the index, the scoring, and the read path against the simplest source.
4. **Read API + Feed UI.** `GET /v1/feed`, seen/dismiss, the Feed page, and the **Feed** button in the Banter header. Make Feed the default Banter landing view.
5. **Cross-app fan-in.** Extend the job to consume cross-app activity events and the concerned-users table (§11), category by category, behind flags. Bam and Brief first (highest signal), then Bell/Bond/Book/Bearing, then Board (direct-only) and the rest.
6. **Unified notifications.** Wire `notification_policy`, the deep-link routing (§12.2), and the Banter header bell to the unified source. Migrate the legacy `banter-notification` path onto the substrate and retire it.
7. **Settings pages.** Org Feed tab (admin) and Platform Feed admin (SuperUser), both with the live preview. This comes last on purpose: ship sensible defaults first, expose the dials once there is a real feed to tune against.

---

## 18. Open forks (decisions I want from you)

1. **DMs in the Feed.** My recommendation is DMs do **not** create Feed entries and route their notification straight to the DM view (§12.2), keeping the Feed for channel and cross-app content. The alternative is a low-volume `banter.dm` Feed category so the Feed is truly "everything." I lean strongly toward keeping DMs out of the Feed (a private 1:1 does not belong in a ranked, broadly-surfaced stream, and you already have a great DM surface), but it is a genuine product call.

2. **Default opt-out strength.** The per-item "unfollow" affordance writes `unfollowed` (soft: keeps direct items) by default, with `muted` (hard) behind a secondary control. I think soft-by-default is right (it protects people from hiding their own assigned work by accident), but if you want "unfollow means gone, period," we flip the default to `muted`.

3. **Seen semantics.** Right now an entry sinks when seen (`seen_multiplier=0.4`) but resurfaces if it gets hot again (new reply bumps recency). The alternative is "seen is sticky-dismissed" (once you have looked, it never comes back unless you explicitly un-dismiss). Sink-and-resurface matches social-feed behavior and your "last commented on bumps it up" requirement, so that is the default, but it does mean the same thread can reappear, which some people find chatty.

4. **Cross-org SuperUser feed.** When a SuperUser switches org context, the Feed scopes to the active org (consistent with every other surface). Confirm that is what you want rather than a cross-org firehose for SuperUsers.

---

## 19. Defaults summary (the "assign sensible values now" deliverable)

- Surfacing is **on by default** for every source; users opt out per scope.
- Joining a channel **auto-follows** it (default-on, no row written).
- `gravity = 1.5`, `recency_offset = 2h`, `engagement_weight = 0.15`, `seen_multiplier = 0.4`, `candidate_window = 30d`.
- Direct-relationship items always surface (subject to `can_access` and not being muted).
- Board canvas edits surface **only** to early contributors (`broad_surface=false`).
- DMs route to the DM view and do not enter the Feed.
- Notifications fire `always` for mentions/assignments/approvals/invites/failed-runs, `direct_only` for task comments/state-changes/thread-replies/ticket-updates, and `never` for ambient followed-source activity.
- Per-category weights as tabled in §8, editable at platform and org levels with a live preview.

Refine all of it against real feeds. The whole architecture is built so that tuning is a settings change, not a redeploy.
