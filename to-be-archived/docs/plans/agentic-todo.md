# Agentic TODO: MCP and Platform Gaps

Status: working draft.
Scope: capability-vs-tool gap analysis. This doc lists the capabilities we want agents to exhibit, checks them against the 294-tool MCP catalog and the platform primitives described in CLAUDE.md, and flags what is missing or underdeveloped. It also assesses whether the same capability belongs in the human-facing UI, or whether it is mostly agent infrastructure.

UI-value rubric:
- **High**: humans will reach for this directly and often; should be a first-class UI surface.
- **Medium**: humans will use it occasionally; worth a small UI affordance.
- **Low**: humans might use it once in a while; a debug page or power-user tool is enough.
- **None**: pure agent/ops infrastructure; no UI needed.

## 1. Passive message-pattern subscriptions

**Capability.** Subscribe to channel messages matching a pattern (keyword set, question shape, entity reference). Must be opt-in per channel, low-latency, and scoped so multiple subscribers can coordinate.

**Current coverage.** `banter_list_messages` and `banter_search_messages` are pull-oriented and historical. Realtime is served by a WebSocket for human UIs but there is no MCP-level "subscribe me to future messages matching X" primitive. Downstream consumers must poll or maintain their own WebSocket with Redis PubSub bridging.

**Gap.** No agent-facing subscription API. Each listener has to build its own polling loop; retention, rate-limiting, and opt-in state live in external runner config rather than in the platform.

**Recommended work.**
- New MCP tool family `banter_subscribe_pattern` / `banter_unsubscribe_pattern` that records a subscription row keyed by (service-account user_id, channel_id, pattern_spec).
- New schema column on `channels`: `agent_subscription_policy` (JSONB: allowed listeners, opt-in timestamp, opted-in-by user).
- New event source `banter.message.matched` on the Bolt catalog, fired server-side when an incoming message matches any active subscription; saves every listener from reimplementing pattern matching.
- Standardize a small interrogative-pattern lexicon in `@bigbluebam/shared` so listeners agree on what counts as a question.

**UI value.** Medium. Channel admins need a settings pane to see "which agents are listening here, why, and how to turn them off." This is the visible manifestation of the privacy posture in the design doc.

## 2. Unified cross-app search

**Capability.** Given a phrase or an entity keyword, return matches across tasks, tickets, deals, contacts, documents, KB entries, and messages in one call.

**Current coverage.** Each app has its own search (`search_tasks`, `helpdesk_search_tickets`, `bond_search_contacts`, `brief_search`, `beacon_search`, `banter_search_messages`). There is no `omni_search` that fans out.

**Gap.** Agents fan out manually. Results are not comparably scored across apps, so ranking a mixed list is ad-hoc.

**Recommended work.**
- New MCP tool `search_everything(query, types[], limit)` that fans out in parallel, deduplicates by entity_type+id, and returns a unified score.
- Optional: a thin search layer on top of Qdrant or Postgres `tsvector` that indexes titles and summaries across apps into one collection, keyed by `(entity_type, entity_id, org_id)`.
- Filter by the caller's visible set up front; do not return hits the caller cannot read.

**UI value.** High. A global command palette search over the whole suite is a common user ask and maps directly onto this tool. Cmd+K already exists per app; a cross-app variant would land well.

## 3. Fuzzy entity resolution from free text

**Capability.** Given a natural-language fragment ("Acme deal", "the login ticket from yesterday", "TASK-123", "Jane's current KR"), resolve to concrete entity IDs.

**Current coverage.** Strong on people (`find_user_by_email`, `find_user_by_name`, `bam_find_user`). Partial on named entities (`bond_search_contacts`, `helpdesk_search_tickets`). Task lookup by human_id works (`bam_get_task_by_human_id`, `helpdesk_get_ticket_by_number`). No generic "extract and resolve entity references from this text" tool.

**Gap.** Every agent reimplements the extract-then-resolve loop. Phrase-to-entity is not consistent across apps; "Acme" in one channel might resolve to a deal, a company, or a project, and each agent will guess differently.

**Recommended work.**
- New MCP tool `resolve_references(text, hints?)` that returns a ranked list of candidate entities with entity_type, entity_id, confidence, and disambiguation hint (e.g., "two companies match 'Acme'"). Underneath, it composes the existing search primitives.
- Pin mention syntax: `[[TASK-123]]`, `[[deal:Acme]]`, `[[contact:jane@...]]` as an unambiguous override.
- Consider a shared resolver service the frontend can also call for autocomplete.

**UI value.** High. The same resolver powers inline mention autocomplete in Banter, Brief, and task comments. Today each client has its own; a shared service would unify behavior and save duplication.

## 4. Time-bucketed count and trend queries

**Capability.** Count and compare entity volume by signature within a rolling window, e.g., "tickets matching phrase X in the last 14 days vs. prior 14 days", with low enough latency to run inside a conversational reply.

**Current coverage.** `bench_compare_periods` and `bench_detect_anomalies` operate over materialized views that must already exist. `bench_query_ad_hoc` is MV-only. Helpdesk and Bam don't expose time-bucketed count-by-phrase endpoints; listing all matching tickets and counting client-side works only at small volumes.

**Gap.** Trend questions inside conversations require either a pre-built MV (inflexible) or client-side aggregation (slow, lossy). The materialized-view tree grows every time a new signal is interesting.

**Recommended work.**
- New MCP tools `helpdesk_ticket_count_by_phrase(phrase, buckets, window)` and `bam_task_count_by_phrase(phrase, buckets, window, label_filter)`.
- On the Bench side, a generic MV that indexes `(entity_type, phrase_hash, bucket, count)` with nightly refresh, queryable via a single `bench_count_phrase` tool.
- Accept the cost: these are approximate counts with a short freshness window, which is correct for conversational use.
- A mechanism for an agent (or a human) to request a new tracked phrase; it is added to the nightly index and becomes queryable.

**UI value.** Medium. A "trends" panel in Helpdesk and in Bam bug boards is genuinely useful for support and engineering leads, but this capability is most valuable inside agent replies. A small histogram-by-phrase UI is a reasonable side benefit.

## 5. Activity-log querying

**Capability.** Answer "who last changed X?", "what happened to this entity in the last 24 hours?", "has anyone touched this project today?".

**Current coverage.** `activity_log` is partitioned and populated by the API plugin for Bam, with `bond_activities` and `ticket_activity_log` separately for their apps. There is no MCP tool to query any of these.

**Gap.** The richest audit data in the suite is invisible to agents. Several listener capabilities (most visibly the lightweight context lookups and the who-last-worked-on questions) would be far better served with direct activity-log access.

**Recommended work.**
- New MCP tool `activity_query(entity_type, entity_id, limit, since)` returning normalized rows across `activity_log`, `bond_activities`, `ticket_activity_log`, and (if added) Brief/Beacon/Bolt equivalents.
- New MCP tool `activity_by_actor(actor_id, since)` for agent-audit use cases (verify your own recent activity, produce the daily self-digest).
- Platform-wide schema addition: `actor_type` column on `activity_log` (and equivalents) so queries can filter `human` vs `agent` vs `system` without email-domain inference.

**UI value.** High. An entity-history sidebar is a feature users ask for across every app. This tool unlocks both the agent and the UI uses in one stroke.

## 6. Composite subject-centric views

**Capability.** Given a company, a project, or a person, return the composite view across all apps in one call (deals, tickets, invoices, tasks, goals, recent activity).

**Current coverage.** None as a single call. Callers compose 4-6 tools and stitch the result.

**Gap.** The same composition logic is implemented N times. Latency of composing in the caller is worse than a server-side composite, and the result shape drifts between callers.

**Recommended work.**
- New MCP tool `account_view(company_id or contact_id or domain)` returning `{deals[], tickets[], invoices[], tasks[], recent_activity[], owners[]}`.
- New MCP tool `project_view(project_id)` returning `{open_tasks_count, active_sprint, goals_linked, recent_brief_docs, recent_beacon_entries, top_contributors}`.
- New MCP tool `user_view(user_id)` returning `{owned_deals[], assigned_tasks[], open_tickets[], goals_owned[], recent_activity[]}`.
- Each composite respects the caller's visibility.

**UI value.** High. These are the account page, the project overview, and the person profile. They already exist piecemeal; consolidating them behind one tool and one component saves frontend duplication.

## 7. Duplicate detection primitives

**Capability.** Given an entity, return likely duplicates with confidence scores and evidence; persist "this pair is not a duplicate" decisions so they are not re-surfaced.

**Current coverage.** `bond_search_contacts` is fuzzy but un-scored. No tool for "given contact X, find likely duplicates". No tool for "given ticket X, find similar open tickets". No storage for decline decisions.

**Gap.** Duplicate detection is reinvented per agent. Decline memory lives in agent runner state, which is ephemeral and inconsistent.

**Recommended work.**
- New MCP tools `bond_find_duplicates(contact_id)` and `helpdesk_find_similar_tickets(ticket_id, status_filter)`.
- New schema table `dedupe_decisions(entity_type, id_a, id_b, decided_by, decision, decided_at)` with a "not a duplicate" flag and a staleness window.
- New MCP tools `dedupe_record_decision(...)` and `dedupe_list_pending(entity_type)` so multiple callers see the same decisions.

**UI value.** Medium. A "potential duplicates" panel on contact and ticket detail pages is useful but not common enough to be front-and-center. The shared decline table is infrastructure; no direct UI.

## 8. Ownership and expertise inference

**Capability.** Answer "who owns this domain?" and "who last worked on this area?" by aggregating ownership signals across Beacon, Bam activity, Bond coverage, and Brief authorship.

**Current coverage.** `beacon_graph_hubs` returns authority nodes but keyed by entry, not by topic. `search_tasks` can be filtered by assignee and label, but composing "most recent assignees on tasks matching topic X" is multi-call and noisy.

**Gap.** No canonical "subject-matter expert for topic X" tool. Agents do bespoke signal aggregation and the results vary.

**Recommended work.**
- New MCP tool `expertise_for_topic(topic_query, signal_weights?)` returning ranked people with cited signals (Beacon ownership, Bam activity, Bond accounts, Brief authorship).
- Consider a daily materialized view `mv_topic_expertise` that precomputes topic-to-person scores to keep the tool fast.

**UI value.** Medium. A "who to ask about this" affordance on task, ticket, and Beacon detail pages would get use. A standalone "directory of expertise" page is probably too much.

## 9. Approval queues and HITL inboxes

**Capability.** Agents produce drafts, proposals, and pending destructive actions that require human review. Humans need one place to see everything waiting on them.

**Current coverage.** Agent proposals currently live as Banter threads, task comments, and per-app flags (e.g., Blast's `require_human_approval`). The `notifications` table is a pull-down inbox but does not model approval semantics (state, decision, actor, resolved-at).

**Gap.** Proposals are fragmented. A human cannot ask "what am I being asked to approve?" across the whole suite.

**Recommended work.**
- New schema table `agent_proposals(id, org_id, actor_id, proposed_action, proposed_payload, approver_id, status, decided_at, decision_reason)`.
- New MCP tools `proposal_create(...)`, `proposal_list(approver_id, status)`, `proposal_decide(id, decision, reason)`.
- Confirmation tokens (`confirm_action` flow) graduate to a 5-minute default when the approver is a human, while keeping 60 seconds for agent-to-agent chains. The 60-second fixed value is too short for asynchronous human review.
- Events fired on proposal creation and decision so Bolt rules can route follow-up.

**UI value.** High. An "Approvals" inbox, per-user and per-team, is a feature the suite currently lacks and that users will want the moment multi-agent work is live. It also subsumes Blast's ad-hoc approval flag.

## 10. Agent identity, audit, and heartbeat

**Capability.** Distinguish agent actors from humans in queries and audit; detect when an agent runtime goes dark; produce reliable self-audit digests.

**Current coverage.** Agents are realized as locked users with `bbam_svc_` key prefixes. No `actor_type` / `is_agent` column on `users` or `activity_log`. No heartbeat endpoint.

**Gap.** "Show me all mutations by agents in the last 24h" requires inferring identity from email domain (`svc+*@system.local`). "Has my agent been running?" has no platform-level answer.

**Recommended work.**
- Schema: `users.kind enum('human','agent','service')` and backfill via email-pattern migration. `activity_log.actor_type` mirrored from the user row at write time.
- New MCP tool `agent_heartbeat(runner_id, capabilities[], version)` recorded in an `agent_runners` table. Liveness derived from `last_heartbeat_at`.
- New MCP tool `agent_audit(agent_user_id, since)` returning a typed activity stream keyed by agent, including all posts, comments, mutations, and errors.
- New MCP tool `agent_self_report()` that an agent calls at the end of each run to write its own digest entry.

**UI value.** Medium. A "Platform > Agents" page listing active runners, last heartbeat, recent actions, and kill-switch state is natural and answers operator questions. The self-audit stream is ops-facing; a compact admin view is enough.

## 11. Visibility and access preflight

**Capability.** Before surfacing an entity in a chat reply, verify the asker can see it, so agents do not leak private records through cross-referenced queries.

**Current coverage.** RLS enforces per-query scope when `BBB_RLS_ENFORCE=1`, but that only covers rows the agent reads on the asker's behalf. Agents running under their own service-account key read the agent's visibility, not the asker's.

**Gap.** An agent on `read_write` scope will happily read an entity its service account can see, cite it in a public channel, and leak content the human asker was not supposed to see.

**Recommended work.**
- New MCP tool `can_access(asker_user_id, entity_type, entity_id)` returning boolean plus reason. Fast; backed by the same RLS policies.
- Convention: any agent that posts cross-app results into a shared surface must preflight every cited entity through `can_access(asker_user_id, ...)` and filter out non-accessible ones.
- Consider a delegated-scope model: an agent invoked on behalf of a human can optionally mint a short-lived token scoped to the asker's visibility, and run the surfacing query through that.

**UI value.** None (direct). Humans do not call this themselves. It is infrastructure for correct agent behavior.

## 12. Bolt observability enhancements

**Capability.** Explain why a rule fired or did not fire, diagnose repeated failures, and detect event-name drift at runtime.

**Current coverage.** `bolt_executions` and `bolt_execution_detail` cover post-hoc inspection. `bolt_test` fires a rule with a simulated payload. The CI drift guard `scripts/check-bolt-catalog.mjs` catches source-prefixed event names at PR time but not at runtime.

**Gap.** No "trace this event through all rules that matched or skipped it" view. No live event tap. No runtime drift alerts.

**Recommended work.**
- New MCP tool `bolt_event_trace(event_id)` returning every rule that evaluated the event, the condition result, and the downstream action outcomes.
- New MCP tool `bolt_recent_events(source?, event?, since)` for live-ish inspection.
- Emit a platform event `bolt.catalog.drift_detected` when an ingested event name does not appear in the registered catalog; let an agent or an ops dashboard subscribe.

**UI value.** Medium. A Bolt "Execution Explorer" page already exists in spirit; adding a per-event trace view and a drift panel would be a natural expansion and useful to human rule authors.

## 13. Scheduled and delayed posting

**Capability.** Post a Banter message at a future time, respecting per-channel quiet hours, without the sender needing its own scheduler.

**Current coverage.** `banter_post_message` is immediate. No `scheduled_at` parameter. No platform-level quiet-hours enforcement on posts.

**Gap.** Any agent that wants to respect quiet hours or batch delivery for a morning post has to implement its own scheduler. This duplicates effort and makes per-channel quiet hours brittle.

**Recommended work.**
- Extend `banter_post_message` with optional `scheduled_at`. Backed by a BullMQ delayed job.
- Schema: `channels.quiet_hours_policy` (JSONB: timezone, allowed hours, urgency override). Platform honors it for scheduled posts and rejects or defers immediate posts according to the sender's priority flag.
- New MCP tool `banter_schedule_post(...)` as a clean alias so scheduled-use callers do not conflate immediate and deferred paths.

**UI value.** Medium. Humans will use a "schedule this message" affordance in Banter's composer as well, especially for cross-timezone teams. This is a dual-use capability.

## 14. Upsert and idempotent writes

**Capability.** Create-or-update by natural key (email for contacts, ticket number for tickets, slug for documents) so intake and webhook flows can safely retry without dedupe work.

**Current coverage.** Mostly missing. `bond_create_contact` does not upsert by email. `beacon_create` does not upsert by slug. Some helpdesk flows have idempotency via ticket number but not for helpdesk_users by email.

**Gap.** Intake and sync agents must call search-then-update-or-create. Retries produce duplicates on transient errors.

**Recommended work.**
- New MCP tools `bond_upsert_contact(email, ...)`, `beacon_upsert_by_slug(slug, ...)`, `helpdesk_upsert_user(email, ...)`, and a generic `task_upsert_by_external_id(external_id, ...)` for imports.
- Return a `created` vs `updated` flag so callers can log correctly.
- Document the idempotency key per tool so caller retries are safe.

**UI value.** Low. Humans do not distinguish upsert from create; they click "save" and the UI figures it out. This is mostly a webhook and agent concern.

## 15. Platform policy access

**Capability.** Read per-agent and per-channel policy flags (kill switches, allowed tool sets, listener opt-in lists) from one place, so every runner enforces them identically.

**Current coverage.** `get_platform_settings` exists but is a broad get. No per-agent or per-channel substructure is formalized.

**Gap.** Each runner invents its own policy shape. Kill switches are mentioned in the design doc but not wired to a canonical schema.

**Recommended work.**
- Schema: `agent_policies(agent_user_id, enabled, allowed_tools[], channel_subscriptions[], rate_limit_override, updated_at, updated_by)`.
- New MCP tools `agent_policy_get(agent_user_id)`, `agent_policy_set(...)`, `agent_policy_list(org_id)`.
- On every tool invocation by a service-account, auth middleware fails closed if `enabled = false` or if the tool is not in `allowed_tools`.

**UI value.** Medium. The "Platform > Agents" settings page (alluded to in section 10) is where humans manage these flags. Without a UI, agent kill switches will be edited via SQL, which is worse than the problem it solves.

## 16. Cross-app entity linking

**Capability.** Durably link entities across apps (ticket to deal, task to Brief doc, booking to contact) with a first-class relationship table.

**Current coverage.** Point-to-point: `brief_link_task`, `beacon_link_create`, `helpdesk_tickets.task_id`, `bond_deal_id` on `bill_invoices`, `bam_project_id` on booking pages. Each app has its own small set of FKs.

**Gap.** There is no generic "links to / linked from" view across an entity. Building a composite view (section 6) means knowing every app-specific column.

**Recommended work.**
- New schema table `entity_links(src_type, src_id, dst_type, dst_id, link_kind, created_by, created_at)`. Existing per-app FKs stay; `entity_links` is additive for the links that cross app boundaries.
- New MCP tools `entity_links_list(type, id)`, `entity_link_create(...)`, `entity_link_remove(...)`.
- Backfill from the known per-app columns.

**UI value.** Medium. A "Related" sidebar that shows everything linked to an entity is a feature each app benefits from. Behind the scenes this is the same table; in front of the user it looks like a natural detail-page widget.

## 17. Attachment and file metadata

**Capability.** Inspect uploaded file metadata (size, mime, signature result) from the agent layer without reaching into MinIO directly.

**Current coverage.** Upload routes exist; scanning happens in the worker fleet. No MCP-level tool to read metadata for a specific upload.

**Gap.** Any agent that wants to react to an uploaded file (Blank intake with attached files, Brief imports, ticket attachments) has no clean read path.

**Recommended work.**
- New MCP tools `attachment_get(upload_id)` returning `{mime, size, scan_status, scan_signature?, uploader_id, uploaded_at, deep_link}`.
- New MCP tool `attachment_list(entity_type, entity_id)` for per-entity enumeration.
- Scan status becomes a first-class field agents and humans can filter on.

**UI value.** Low. Humans already see attachments in their hosting surfaces. An ops "recent uploads" view with scan status is a small tool but not a headline feature.

## 18. Book availability for mixed human/agent rosters

**Capability.** Find slots where a set of humans (and, where relevant, agents that attend calls) are free within working hours.

**Current coverage.** `book_get_team_availability` and `book_find_meeting_time` work for users with calendars. Agents typically do not have calendars and are treated as absent.

**Gap.** Meetings that invite an agent (scribe, EA-style assistant) cannot treat the agent's availability uniformly. Minor, but worth noting.

**Recommended work.**
- A simple convention: service-account users have unlimited virtual availability, subject to a rate limit (one concurrent call per runner instance). No calendar; the scheduler ignores them when computing conflicts.
- New MCP tool `book_find_meeting_time_for_users(user_ids[], duration, window, respect_working_hours_for_humans_only)`.

**UI value.** Low. The existing scheduling UI handles the 95% case.

## 19. Ingest-time deduplication for intake flows

**Capability.** When a new form submission, ticket, or lead arrives, determine whether it is a duplicate of something received in the last N minutes, before creating downstream entities.

**Current coverage.** None at the platform level. Each intake flow implements its own (or none).

**Gap.** A burst of identical submissions produces a burst of identical downstream entities and agent responses.

**Recommended work.**
- New MCP tool `ingest_fingerprint_check(source, fingerprint, window_seconds)` that hashes the incoming payload into a fingerprint and reports whether it was seen within the window. Backed by a small Redis key-space.
- Convention: intake agents fingerprint the canonicalized body (lowercase, whitespace-normalized, stripped of reply-quoted text) and skip creation on hit.

**UI value.** None. Purely intake infrastructure.

## 20. Outbound webhook or push to agent runners

**Capability.** Deliver events to agent runners running outside the cluster, without polling.

**Current coverage.** No outbound push. Agents poll or open a WebSocket.

**Gap.** External-host agents waste capacity polling. Latency floors are higher than they need to be.

**Recommended work.**
- New platform component: an outbound webhook dispatcher keyed on `agent_runners.webhook_url`, firing for subscribed Bolt events.
- Delivery guarantees: at-least-once, signed with `INTERNAL_SERVICE_SECRET`-equivalent per-runner secret, with backoff and a dead-letter queue.

**UI value.** Low. An admin page showing delivery health (last successful delivery, failure count) is helpful but narrow.

## Prioritization sketch

If the suite can only ship three of these in the next wave, the highest-leverage picks are:

1. **Section 10 (agent identity, audit, heartbeat)** and its `actor_type` schema addition. It unblocks observability, unblocks correct auditability, and is a prerequisite for most of the others.
2. **Section 9 (approval queue)** with a 5-minute human-grade confirmation window. This turns the current Banter-thread HITL convention into a durable surface and has direct, visible UI value.
3. **Section 11 (visibility preflight)**. Without `can_access`, any listener that pulls cross-app data into a shared channel is a potential privacy leak. This needs to precede widespread passive-listener deployment.

Everything else is high-value but second-wave.
