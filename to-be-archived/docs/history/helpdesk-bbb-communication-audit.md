# Helpdesk ↔ BigBlueBam Communication Audit

Compiled from 9 parallel audits covering: data model linkage, ticket creation flow, agent reply flow, realtime WebSocket, cross-service auth, status sync, frontend polling, user auth isolation, and error/retry handling.

## Status Summary (as of granular-permissions branch, 2026-04-05)

- **Resolved:** 53 of 57
- **Partial:** 3 of 57
- **Deferred:** 1 of 57
- **Open:** 0 of 57

## Headline Findings

1. **Helpdesk has NO realtime infrastructure at all.** No WebSocket server, no client, no nginx routing. Customers wait for manual refresh (`staleTime: 60s`). Agent replies effectively invisible to customers until they refresh.

2. **No multi-tenant isolation.** `helpdesk_users` table has no `org_id` — all customers share a global pool. `GET /helpdesk/agents/tickets` lists ALL tickets across ALL organizations.

3. **Helpdesk-api writes directly to BBB tables.** No API call, no service token, no HMAC, no dedicated internal routes. Relies entirely on Docker network + shared Postgres credentials. No distinguishable actor in BBB activity_log for helpdesk-originated operations.

4. **Many silent failures.** Broadcast failures, ticket-status sync failures, and task creation failures are caught and swallowed without logging. Customer gets ticket, BBB team sees nothing.

5. **Bidirectional sync is broken.** Customer replies don't change ticket status. Customer closing ticket doesn't move task phase. Agent moving task → "resolved" works, but reverse flows don't.

---

## P0 — CRITICAL

| # | Status | Issue | File |
|---|--------|-------|------|
| HB-1 | RESOLVED | **No realtime infrastructure** — no WebSocket server in helpdesk-api, no client in helpdesk frontend, no nginx `/helpdesk/ws` route | apps/helpdesk-api/src/server.ts, apps/helpdesk/src/, infra/nginx/nginx.conf |
| HB-2 | RESOLVED | **Customer replies invisible until manual refresh** — `staleTime: 60000`, no polling, no WebSocket, no refetchOnWindowFocus | apps/helpdesk/src/main.tsx, apps/helpdesk/src/hooks/use-tickets.ts:51 |
| HB-3 | RESOLVED | **`broadcastTicketStatusChanged()` defined but never called** — dead code, no broadcasts on ticket updates | apps/helpdesk-api/src/lib/broadcast.ts:32 |
| HB-4 | RESOLVED | **Authorization bypass: ticket reopen** — UPDATE missing `helpdesk_user_id` check; customer A can reopen customer B's tickets by UUID | apps/helpdesk-api/src/routes/ticket.routes.ts:317 |
| HB-5 | DEFERRED | **No org_id on `helpdesk_users` table** — all customers in a single global pool, no multi-tenant partition | apps/helpdesk-api/src/db/schema/helpdesk-users.ts |
| HB-6 | RESOLVED | **Agent `/tickets` endpoint returns ALL orgs' tickets** — no org filtering with only a shared API key | apps/helpdesk-api/src/routes/agent.routes.ts:77 |
| HB-7 | RESOLVED | **Helpdesk bypasses BBB API — writes directly to tasks table** — no service auth, no audit, no identifiable actor | apps/helpdesk-api/src/routes/ticket.routes.ts:104 |
| HB-8 | RESOLVED | **No idempotency on ticket creation** — client retry creates duplicate tickets silently | apps/helpdesk-api/src/routes/ticket.routes.ts:47 |
| HB-9 | RESOLVED | **No distributed transaction** — ticket+task creation not wrapped; orphaned state if one fails | apps/helpdesk-api/src/routes/ticket.routes.ts:104-178 |
| HB-10 | RESOLVED | **Silent ticket status sync failures** — `catch {}` swallows errors, task moves to "resolved" while ticket stays "open" | apps/api/src/services/task.service.ts:234-273 |
| HB-11 | RESOLVED | **Missing ON DELETE on `helpdesk_user_id` FK** — customer deletion fails with constraint violation | infra/postgres/init.sql:414 |
| HB-12 | RESOLVED | **BBB session cookie leaks to agent endpoints** — any BBB user can call helpdesk agent APIs via BBB `session` cookie | apps/helpdesk-api/src/routes/agent.routes.ts:28 |
| HB-13 | RESOLVED | **Unauthenticated `GET /helpdesk/settings`** — exposes `default_project_id`, `allowed_email_domains`, org structure | apps/helpdesk-api/src/routes/settings.routes.ts:64 |
| HB-14 | RESOLVED | **Agent can forge `author_id` on messages** — not a FK, defaults to null UUID `00000000...`, agent can claim any identity | apps/helpdesk-api/src/routes/agent.routes.ts:169 |
| HB-15 | RESOLVED | **Customer reply doesn't update ticket status from `waiting_on_customer`** — ticket stays stuck forever | apps/helpdesk-api/src/routes/ticket.routes.ts:239 |
| HB-16 | RESOLVED | **Customer closing ticket doesn't move linked task to terminal phase** — agent sees stale task | apps/helpdesk-api/src/routes/ticket.routes.ts:351 |
| HB-17 | RESOLVED | **Email verification stub (TODO)** — self-registration allows impersonating any email; `notify_on_agent_reply` queues no email | apps/helpdesk-api/src/routes/auth.routes.ts:100, apps/helpdesk-api/src/routes/agent.routes.ts:197 |
| HB-18 | RESOLVED | **`is_internal` only enforced on read path** — agent must remember flag; no write-side safeguard against leaking internal notes to customer | apps/helpdesk-api/src/routes/agent.routes.ts:15 |

## P1 — HIGH

| # | Status | Issue | File |
|---|--------|-------|------|
| HB-19 | RESOLVED | No HTML sanitization on ticket description (XSS via stored description → rendered in BBB) | apps/helpdesk-api/src/routes/ticket.routes.ts:12 |
| HB-20 | RESOLVED | Ticket↔task linkage is unidirectional (no `ticket_id` on tasks) + stored in JSONB `custom_fields` | apps/api/src/db/schema/tasks.ts, apps/helpdesk-api/src/routes/ticket.routes.ts:166 |
| HB-21 | RESOLVED | Two separate Drizzle schemas for same `tickets` table (B3 minimal, helpdesk fuller) — drift risk | apps/api/src/db/schema/tickets.ts vs apps/helpdesk-api/src/db/schema/tickets.ts |
| HB-22 | RESOLVED | No Fastify request timeout — long DB queries hang connections indefinitely | apps/helpdesk-api/src/server.ts |
| HB-23 | RESOLVED | BullMQ is a dependency but never used — no dead-letter queue, no retry for failed task creation | apps/helpdesk-api/package.json |
| HB-24 | RESOLVED | No health checks between services — helpdesk-api doesn't verify BBB reachability | apps/helpdesk-api/src/server.ts |
| HB-25 | RESOLVED | Global rate limit keyed by IP only — one compromised customer account can spam 100 tickets/min | apps/helpdesk-api/src/server.ts:63 |
| HB-26 | RESOLVED | Dead code in `requireAgentAuth` (`if (true)`) makes auth logic confusing/potentially broken | apps/helpdesk-api/src/routes/agent.routes.ts:63 |
| HB-27 | RESOLVED | Agent's message post uses non-timing-safe key comparison (string `===`) | apps/helpdesk-api/src/routes/agent.routes.ts:48 |
| HB-28 | RESOLVED | Shared `AGENT_API_KEY` not hashed, not rotatable, not per-agent — can't audit individual agents | apps/helpdesk-api/src/env.ts:38 |
| HB-29 | RESOLVED | Broken optimistic UI — user's input clears but message doesn't appear until server round-trip | apps/helpdesk/src/pages/ticket-detail.tsx:88 |
| HB-30 | RESOLVED | Full ticket refetch on every message post (`invalidateQueries`) — wasteful on large conversations | apps/helpdesk/src/hooks/use-tickets.ts:84 |
| HB-31 | RESOLVED | No message pagination/virtualization — long conversations load entire history in DOM | apps/helpdesk/src/pages/ticket-detail.tsx:304 |
| HB-32 | RESOLVED | Default 7-day session TTL for unverified customers (higher-risk than BBB agents) | apps/helpdesk-api/src/env.ts:12 |
| HB-33 | RESOLVED | Weak rate limiting on login/register (100/min) — brute-force viable | apps/helpdesk-api/src/server.ts:63 |
| HB-34 | RESOLVED | Lossy phase→status mapping (5 statuses reduce to 3 phase categories) — can't distinguish `waiting_on_customer` from `in_progress` | apps/api/src/services/task.service.ts:245 |
| HB-35 | RESOLVED | Status sync not idempotent — re-running produces duplicate "Status changed" system messages | apps/api/src/services/task.service.ts:260 |
| HB-36 | RESOLVED | No reporter_id set on helpdesk-created tasks (NULL) — customer identity lost in activity log | apps/helpdesk-api/src/routes/ticket.routes.ts:104 |
| HB-37 | RESOLVED | Default_phase_id not validated before task creation — tasks with NULL phase become invisible | apps/helpdesk-api/src/routes/ticket.routes.ts:112 |

## P2 — MEDIUM

| # | Status | Issue | File |
|---|--------|-------|------|
| HB-38 | RESOLVED | No per-ticket "rooms" — when realtime is added, isolation requires design | — |
| HB-39 | RESOLVED | No typing indicator (Banter has one) | — |
| HB-40 | RESOLVED | No unread message badges on ticket list | apps/helpdesk/src/pages/tickets-list.tsx |
| HB-41 | RESOLVED | No browser notifications / sound | — |
| HB-42 | RESOLVED | No offline detection or auto-reconnect (helpdesk frontend uses `retry: 1`, no backoff) | apps/helpdesk/src/main.tsx:11 |
| HB-43 | RESOLVED | `description_plain` stored identical to `description` (doesn't strip HTML) | apps/helpdesk-api/src/routes/ticket.routes.ts:111 |
| HB-44 | RESOLVED | Email verification token stored in plaintext | apps/helpdesk-api/src/db/schema/helpdesk-users.ts:11 |
| HB-45 | RESOLVED | No ticket_activity_log equivalent — ticket status changes not audited on helpdesk side | apps/helpdesk-api/src/db/schema/ |
| HB-46 | PARTIAL | No metrics/observability on task creation latency, failure rate, broadcast success | — |
| HB-47 | RESOLVED | Pub/sub not durable — offline subscribers miss events permanently | apps/helpdesk-api/src/lib/broadcast.ts |
| HB-48 | RESOLVED | Request ID not propagated to dependent services — no cross-service trace | apps/helpdesk-api/src/server.ts:24 |
| HB-49 | RESOLVED | Agent authentication via shared session cookie fragile (no role check against org_memberships) | apps/helpdesk-api/src/routes/agent.routes.ts:28-72 |
| HB-50 | PARTIAL | Ticket messages cascade delete, but task comments are orphaned (separate tables, no sync) | — |
| HB-51 | RESOLVED | Ticket ID enumeration possible (404 for both "not found" and "not yours") | apps/helpdesk-api/src/routes/ticket.routes.ts:207 |
| HB-52 | RESOLVED | Missing CSRF protection (SameSite=lax mitigates but doesn't fully protect) | apps/helpdesk-api/src/routes/auth.routes.ts:32 |

## P3 — LOW / Design

| # | Status | Issue | File |
|---|--------|-------|------|
| HB-53 | PARTIAL | No skeleton loaders — blank pages while loading | apps/helpdesk/src/pages/ |
| HB-54 | RESOLVED | No per-endpoint rate limits on agent API | apps/helpdesk-api/src/routes/agent.routes.ts |
| HB-55 | RESOLVED | No duplicate/merge ticket support | apps/helpdesk-api/src/db/schema/tickets.ts |
| HB-56 | RESOLVED | task_id FK uses SET NULL on task deletion — orphaned tickets | infra/postgres/init.sql:415 |
| HB-57 | RESOLVED | Account lockout after repeated failed logins not implemented | apps/helpdesk-api/src/routes/auth.routes.ts |

---

## Recommended Immediate Roadmap

### Week 1 — Stop the bleeding (P0 security)
1. **Fix HB-4** (ticket reopen authorization bypass) — 1 line WHERE clause
2. **Fix HB-6** (agent endpoint org isolation)
3. **Fix HB-12** (remove BBB session cookie from agent auth)
4. **Fix HB-13** (add auth to /helpdesk/settings)
5. **Fix HB-14** (enforce author_id from session, reject spoofed)
6. **Fix HB-18** (add write-side `is_internal` safeguards)
7. **Fix HB-11** (add ON DELETE CASCADE to helpdesk_user_id FK)

### Week 2 — Data integrity
1. **Fix HB-8** (idempotency keys on ticket creation)
2. **Fix HB-9** (wrap ticket+task creation in transaction)
3. **Fix HB-10** (log sync failures, queue retries)
4. **Fix HB-3** (actually call broadcastTicketStatusChanged)
5. **Fix HB-19** (HTML sanitization on ticket description)

### Week 3 — Realtime infrastructure (HB-1 + HB-2)
1. Add `@fastify/websocket` to helpdesk-api
2. Create `apps/helpdesk-api/src/plugins/websocket.ts` mirroring Banter's pattern
3. Add `/helpdesk/ws` route with proper upgrade headers in nginx.conf
4. Subscribe customers to `ticket:${ticketId}` rooms
5. Broadcast `ticket.message.created`, `ticket.status.changed` on write
6. Create `apps/helpdesk/src/lib/websocket.ts` client with auto-reconnect
7. Create `useRealtimeTicket(ticketId)` hook that invalidates queries on events
8. Remove the 60s staleTime dependency — rely on WebSocket invalidation

### Week 4 — Bidirectional status sync (HB-15, HB-16, HB-34)
1. Customer reply → set ticket.status = 'open' if was 'waiting_on_customer'
2. Customer close → move linked task to terminal phase
3. Agent status update → sync task phase (reverse of current one-way sync)

### Week 5+ — Multi-tenancy (HB-5)
1. Add `org_id` to helpdesk_users table
2. Scope all queries by org_id
3. Update auth to establish org context at login

### Later — UX parity with Banter
- Typing indicators, unread badges, optimistic UI, virtualized message list, browser notifications
