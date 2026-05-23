# Cross-Product Implementation Plan (2026-04-14)

## Scope

This plan covers cross-cutting infrastructure spanning multiple apps, separate from the 14 per-app/platform plans. Five areas: (1) canonical `publishBoltEvent` consolidation into `@bigbluebam/shared`; (2) Bolt event catalog additions for all events emitted by per-app plans; (3) event-naming convention enforcement; (4) shared Zod schemas rollout across apps that lack them; (5) cross-app integration test harness.

**In scope:** canonical event publisher in `packages/shared/src/bolt-events.ts`; event catalog entries for ~30 new events; deleting per-service publisher copies; shared Zod schemas rollout; integration test harness at `apps/integration-tests/`.

**Out of scope:** `scripts/check-bolt-catalog.mjs` drift guard (owned by Bolt_Plan.md G4); event-naming historical migration (owned by Bolt_Plan.md 0096); notification fan-out dispatcher (deferred to Wave 3.3); Banter approval DM automation template (deferred to Wave 3.2); per-app gaps belonging to individual plans.

## Gap inventory

| Gap | Priority | Description |
|---|---|---|
| G1 | P0 | Canonical `publishBoltEvent` at `packages/shared/src/bolt-events.ts`; delete per-service copies |
| G2 | P0 | Append ~30 new event definitions to `apps/bolt-api/src/services/event-catalog.ts` |
| G3 | P0 | Verify all `publishBoltEvent` call sites use bare event names and explicit `source` argument |
| G4 | P0 | Roll out `packages/shared/src/schemas/<app>.ts` for Banter, Beacon, Bearing, Board, Book, Brief, Helpdesk, Platform (per-app plans that need them) |
| G5 | P1 | Cross-app integration test harness at `apps/integration-tests/` exercising Blank → Bond → Bam → Bolt → Banter flow |
| G6 | P2 | Notification fan-out dispatcher (deferred; concept described) |
| G7 | P2 | Banter approval DM automation template (deferred; owned by Wave 3.2) |

## Migrations

**Reserved slots: 0120-0129 (unused).**

No cross-product migrations claimed at this stage. All schema work lives in per-app plans. Slots 0120-0129 are held in reserve for future cross-cutting schema work (e.g., unified notification dispatch tables, cross-product reference registry).

## Shared packages

### `packages/shared/src/bolt-events.ts` (new, G1)

**Canonical signature:**
```typescript
export async function publishBoltEvent(
  eventType: string,
  source: string,
  payload: Record<string, unknown>,
  organizationId: string,
  actorId?: string,
  actorType?: 'user' | 'agent' | 'system',
): Promise<void>;
```

**Pipeline:**
1. Accept bare event type (e.g., `deal.rotting`, NOT `bond.deal.rotting`).
2. Require explicit `source` parameter (e.g., `'bond'`).
3. HTTP POST to `${BOLT_API_INTERNAL_URL}/v1/events/ingest` with headers `X-Internal-Secret`, `X-Organization-Id`, `X-Actor-Id` (if set), `X-Actor-Type`.
4. Body: `{ event_type, source, payload, organization_id, actor_id, actor_type, timestamp }`.
5. Fire-and-forget: never throws, never blocks caller. Wrapped in try/catch; errors logged at debug level.
6. Env reads: `BOLT_API_INTERNAL_URL` (default `http://bolt-api:4006`), `INTERNAL_SERVICE_SECRET`.

**Export:** re-export from `packages/shared/src/index.ts`.

**Cleanup task:** grep for `export.*publishBoltEvent|function publishBoltEvent` under `apps/*/src/` and delete any per-service copies. Refactor imports to `import { publishBoltEvent } from '@bigbluebam/shared'`.

### Shared Zod schemas rollout (G4)

Per-app plans already claim their schema files:
- `packages/shared/src/schemas/banter.ts` — owned by Banter_Plan.md.
- `packages/shared/src/schemas/book.ts` — owned by Book_Plan.md.
- `packages/shared/src/schemas/brief.ts` — owned by Brief_Plan.md.
- `packages/shared/src/schemas/platform.ts` — owned by Platform_Plan.md.
- `packages/shared/src/schemas/helpdesk.ts` — owned by Helpdesk_Plan.md.
- `packages/shared/src/schemas/board.ts` — owned by Board_Plan.md.

**This plan adds the remaining apps** that the per-app plans did not explicitly claim:
- `packages/shared/src/schemas/beacon.ts` (new) — `BeaconEntrySchema`, `BeaconSearchResultSchema`, `BeaconCommentSchema`, `BeaconAttachmentSchema`.
- `packages/shared/src/schemas/bearing.ts` (new) — `BearingGoalSchema`, `BearingKRSchema`, `BearingPeriodSchema`, `GoalStatusEnum`.
- `packages/shared/src/schemas/bond.ts` (new) — `BondContactSchema`, `BondCompanySchema`, `BondDealSchema`, `DealStageEnum`.
- `packages/shared/src/schemas/bolt.ts` (new) — `AutomationDefinitionSchema`, `EventIngestSchema`, `ExecutionStatusEnum`.
- `packages/shared/src/schemas/blast.ts` (new) — `CampaignSchema`, `EngagementEventSchema`.
- `packages/shared/src/schemas/bench.ts` (new) — `DashboardConfigSchema`, `KpiConfigSchema`.
- `packages/shared/src/schemas/bill.ts` (new) — `InvoiceSchema`, `ExpenseSchema`.
- `packages/shared/src/schemas/blank.ts` (new) — `FormSchema`, `SubmissionSchema`.

All exported from `packages/shared/src/schemas/index.ts` barrel.

## Bolt event catalog additions (G2)

**File:** `apps/bolt-api/src/services/event-catalog.ts` (append-only).

**New events to register** (grouped by source):

| Event | Source | Payload shape | Emitted by plan |
|---|---|---|---|
| `form.published` | `blank` | `{ form_id, slug, form_type, form_name, actor, org }` | Blank_Plan G1 |
| `form.closed` | `blank` | `{ form_id, slug, form_name, total_submissions }` | Blank_Plan G1 |
| `submission.created` | `blank` | `{ submission_id, form_id, form_slug, response_data, submitted_by_email, actor, org }` | Blank_Plan G1 |
| `engagement.opened` | `blast` | `{ engagement_id, campaign_id, contact_id, occurred_at }` | Blast_Plan G1 |
| `engagement.clicked` | `blast` | `{ engagement_id, campaign_id, contact_id, clicked_url, occurred_at }` | Blast_Plan G1 |
| `engagement.unsubscribed` | `blast` | `{ engagement_id, campaign_id, contact_id, occurred_at }` | Blast_Plan G1 |
| `engagement.bounced` | `blast` | `{ engagement_id, campaign_id, contact_id, bounce_type, occurred_at }` | Blast_Plan G1 |
| `campaign.completed` | `blast` | `{ campaign_id, campaign_name, total_sent, total_delivered, total_bounced, total_opened, total_clicked }` | Blast_Plan G2 |
| `goal.created` | `bearing` | `{ goal_id, goal_name, owner_id, period_id, actor, org }` | Bearing_Plan G5 |
| `goal.updated` | `bearing` | `{ goal_id, goal_name, changes, actor }` | Bearing_Plan G5 |
| `goal.status_changed` | `bearing` | `{ goal_id, old_status, new_status, actor }` | Bearing_Plan G5 |
| `goal.achieved` | `bearing` | `{ goal_id, goal_name, actor }` | Bearing_Plan G5 |
| `goal.deleted` | `bearing` | `{ goal_id, goal_name, actor }` | Bearing_Plan G5 |
| `goal.watcher_added` | `bearing` | `{ goal_id, watcher_id, actor }` | Bearing_Plan G5 |
| `goal.watcher_removed` | `bearing` | `{ goal_id, watcher_id, actor }` | Bearing_Plan G5 |
| `kr.created` | `bearing` | `{ kr_id, goal_id, kr_name, actor }` | Bearing_Plan G5 |
| `kr.updated` | `bearing` | `{ kr_id, goal_id, changes, actor }` | Bearing_Plan G5 |
| `kr.value_updated` | `bearing` | `{ kr_id, goal_id, old_value, new_value, actor }` | Bearing_Plan G5 |
| `kr.linked` | `bearing` | `{ kr_id, goal_id, link_type, linked_entity_id, actor }` | Bearing_Plan G5 |
| `kr.deleted` | `bearing` | `{ kr_id, goal_id, actor }` | Bearing_Plan G5 |
| `period.activated` | `bearing` | `{ period_id, period_name, actor }` | Bearing_Plan G5 |
| `period.completed` | `bearing` | `{ period_id, period_name, actor }` | Bearing_Plan G5 |
| `period.archived` | `bearing` | `{ period_id, period_name, actor }` | Bearing_Plan G5 |
| `board.locked` | `board` | `{ board_id, board_name, locked, locked_by, locked_at }` | Board_Plan G5 |
| `board.elements_promoted` | `board` | `{ board_id, element_count, task_ids, promoted_by, promoted_at }` | Board_Plan G5 |
| `event.cancelled` | `book` | `{ event_id, event_title, actor, org }` | Book_Plan G4 |
| `event.rsvp` | `book` | `{ event_id, event_title, response_status, respondent, actor, org }` | Book_Plan G4 |
| `cron.fired` | `bolt` | `{ schedule_id, automation_id, cron_expression, fired_at }` | Bolt_Plan G2 |
| `ticket.created` | `helpdesk` | `{ ticket_id, subject, priority, status, helpdesk_user_id, org }` | Helpdesk_Plan G3 |
| `ticket.status_changed` | `helpdesk` | `{ ticket_id, old_status, new_status, actor }` | Helpdesk_Plan G3 |
| `ticket.message_posted` | `helpdesk` | `{ ticket_id, message_id, author_id, is_internal }` | Helpdesk_Plan G3 |
| `ticket.closed` | `helpdesk` | `{ ticket_id, closed_by, closed_at }` | Helpdesk_Plan G3 |
| `ticket.reopened` | `helpdesk` | `{ ticket_id, reopened_by, reopened_at }` | Helpdesk_Plan G3 |
| `ticket.sla_breached` | `helpdesk` | `{ ticket_id, sla_type, breached_at }` | Helpdesk_Plan G3 |

Each entry in the catalog includes `source`, `event_type`, human-readable `description`, and `payload_schema` (Zod). The drift guard script (owned by Bolt_Plan.md G4) validates at CI time that active automations only reference cataloged events.

## Event naming convention (G3)

Enforcement pattern:
- **Correct:** `publishBoltEvent('form.published', 'blank', payload, orgId)` — bare event name, explicit source.
- **Incorrect:** `publishBoltEvent('blank.form.published', 'blank', payload, orgId)` — prefixed name.

Historical cleanup for existing `bond.deal.rotting` references is owned by Bolt_Plan.md migration 0096. The `apps/worker/src/jobs/bond-stale-deals.job.ts` is updated by Bolt_Plan.md G3 to emit the bare name going forward.

This plan's contribution: during cross-product refactor to the canonical `publishBoltEvent`, every call site is verified by the developer to use bare names. The Bolt drift guard script (Bolt_Plan.md G4) also lints `publishBoltEvent(...)` calls in source to enforce the convention going forward.

## Cross-app integration harness (G5)

**Location:** `apps/integration-tests/` (new directory).

**Purpose:** end-to-end test scaffolding exercising multi-app workflows, validating event routing and data linkage without leaving the test suite.

**Fixture workflow (Blank → Bond → Bam → Bolt → Banter):**
1. Create a Blank form with auto-lead-capture enabled for Bond.
2. Submit the form with contact info.
3. Verify Bond contact created.
4. Verify Blank emitted `submission.created` to Bolt ingest.
5. Create a Bolt automation triggered on `submission.created` that creates a Bam task.
6. Verify Bam task created.
7. Update task status, verify Bam emits `task.updated` to Bolt.
8. Verify Bolt execution log records both event receipts and automation runs.
9. Optional: automation posts Banter DM, verify delivery.

**Test structure:**
```
apps/integration-tests/
  src/
    fixtures/
      stack.fixture.ts              # shared Docker Compose lifecycle
      auth.fixture.ts               # admin user + service account setup
      blank-bond-bam-bolt.fixture.ts
    tests/
      blank-to-bond.e2e.ts
      bond-to-bam.e2e.ts
      bam-to-bolt.e2e.ts
      full-flow.e2e.ts
  docker-compose.test.yml
  package.json
  vitest.config.ts
```

**Execution:** Docker Compose stack with all services (postgres, redis, api, blank-api, bond-api, bolt-api, worker, banter-api) started once per test run. Vitest runs sequentially against the live stack.

## Notification fan-out (G6, deferred)

Deferred to Wave 3.3. Concept: unified dispatcher at `packages/shared/src/services/notification-dispatcher.ts` providing a facade over Banter DM API, Blast email API, frontend toast queue, and future channels. Per-app plans currently call their notification channels independently; consolidation happens after per-app patterns stabilize.

## Banter approval DM automation template (G7, deferred)

Deferred to Wave 3.2. Depends on Bolt_Plan.md G8 (Banter DM failure notification capability). Concept: Bolt automation template for approval workflows (deal rotting, goal at risk, invoice overdue) that posts DM to approver channel with action buttons.

## CI workflows

Additions to existing workflows:
- `.github/workflows/db-drift.yml` (update) — after `pnpm db:check`, run `node scripts/check-bolt-catalog.mjs` (Bolt_Plan.md G4 owns the script; this plan wires it into CI).
- `.github/workflows/integration-tests.yml` (new) — triggers on PR touching `apps/integration-tests/`, `apps/bolt-api/`, `apps/blank-api/`, `apps/bond-api/`, `apps/api/`, `apps/worker/`, or `packages/shared/src/bolt-events.ts`. Brings up test compose stack, runs `pnpm --filter @bigbluebam/integration-tests test`, tears down.

## Tests

- `packages/shared/src/__tests__/bolt-events.test.ts` (new, G1) — canonical `publishBoltEvent`: valid call shape, fire-and-forget error handling, header construction.
- `apps/bolt-api/src/services/__tests__/event-catalog.test.ts` (update, G2) — every registered event has `source`, `event_type`, `description`, `payload_schema` populated.
- Per-app plans own their own publication call-site tests.
- `apps/integration-tests/src/tests/*.e2e.ts` (new, G5) — full-flow integration scenarios.

## Verification steps

```bash
pnpm --filter @bigbluebam/shared build
pnpm --filter @bigbluebam/shared typecheck
pnpm --filter @bigbluebam/shared test
pnpm typecheck
pnpm lint
pnpm lint:migrations

# Verify no prefixed event types in source
# (run after canonical refactor)
pnpm exec node -e "console.log('Grep check: publishBoltEvent with prefixed event')"

# Integration test harness (docker stack required)
docker compose -f apps/integration-tests/docker-compose.test.yml up -d
pnpm --filter @bigbluebam/integration-tests test
docker compose -f apps/integration-tests/docker-compose.test.yml down
```

## Out of scope

Helpdesk and Platform event emission (already covered by their respective plans), advanced event replay or audit trail UI, event schema versioning, Slack/Teams federation, per-event role-based filtering in automations.

## Dependencies

- **Bolt_Plan.md:** provides `scripts/check-bolt-catalog.mjs` drift guard (G4), event-naming migration (0096), cron scheduler synthetic `cron.fired` events (G2).
- **Platform_Plan.md:** provides shared infrastructure packages (`@bigbluebam/logging`, `@bigbluebam/service-health`) that integration tests depend on.
- **Per-app plans (Beacon, Bearing, Bench, Bill, Blank, Blast, Board, Bolt, Bond, Book, Brief, Banter, Helpdesk):** each emits events consumed by this plan's catalog additions, each uses the canonical `publishBoltEvent` created here.

**Event emission flow:**
```
per-app service
  -> publishBoltEvent(event_type, source, payload, orgId)
    -> @bigbluebam/shared/bolt-events.ts
      -> POST /v1/events/ingest (bolt-api internal)
        -> Bolt ingest handler
          -> Query bolt_automations WHERE trigger_event = event_type AND enabled = true
            -> bolt:execute queue job
              -> run actions via MCP /tools/call
```

**Migration numbers claimed: none. Reserved unused: 0120-0129.**
