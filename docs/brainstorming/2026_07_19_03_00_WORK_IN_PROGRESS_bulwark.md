# Bulwark build - work in progress checklist

Spec: `docs/brainstorming/2026_07_19_03_00_APP_DESIGN_bulwark.md` (converged after 3 adversarial rounds).
Branch: `suite-brainstorm`. App id `bulwark`, api port 4021, routes `/bulwark/`, `/bulwark/api/`, `/bulwark/ws`.
Bulwark = AI contract-obligation monitor: extracts a clause-cited obligation ledger, binds each obligation
to a Bolt event pattern, fires against live events to compute notice deadlines + waiver risk, drafts notices,
routes every outbound act through agent_proposals (HITL). Plus vendor-compliance chasing.

## M1 - Scaffold (`apps/bulwark-api` + `apps/bulwark`)
- [x] bulwark-api Fastify server modeled on braid-api (server.ts, env.ts port 4021, plugins rls/auth/permissions/redis, health, Dockerfile, tsup/tsconfig/vitest)
- [x] bulwark SPA scaffolded from blip/braid sibling (vite base /bulwark/, dev port 3021)
- [x] typecheck both green

## M2 - Data model + migrations (9 tables)
- [x] 9 Drizzle schema modules (contracts, obligations, ingest_events, notice_deadlines, waiver_risks, vendor_tiers, compliance_docs, extraction_runs, org_settings) + bbb-refs + entity-links/agent-proposals ref-stubs
- [x] 0234_bulwark_core.sql (contracts/obligations/ingest_events/notice_deadlines/waiver_risks/org_settings + self-FKs + RLS)
- [x] 0235_bulwark_compliance.sql (vendor_tiers/compliance_docs/extraction_runs + RLS)
- [x] migrate applies both; verify \d; db:check clean of bulwark drift; lint:migrations 0

## M3 - Shared Zod schemas
- [x] packages/shared/src/schemas/bulwark.ts (contract/obligation/deadline/waiver/vendor/compliance/settings + JSONB shapes: event_binding, deadline_rule, cited_span, notice_draft)

## M4 - API routes + realtime + engines (delegate)
- [x] all /v1 REST endpoints (Section 5.1), project-membership scoping on read AND write routes
- [x] extraction engine (llm-provider, chunk checkpoint, cited_span verify, dedup_key), firing engine (inbox drain, deterministic arm key), deadline math (timezone/roll-forward), amendment supersession
- [x] single canonical send path (agent_proposals, deterministic recipient/attachment, decider kill-switch + can_access), proposal.decided subscription
- [x] /bulwark/ws project-scoped rooms, source-type enablement + /internal/events (fail-closed on empty secret)

## M5 - MCP tools at full parity (15 tools, delegate)
- [x] apps/mcp-server/src/tools/bulwark-tools.ts (15 tools incl. bulwark_extract_obligations, bulwark_check_notice_risk); bulwark.* allowlist; confirm_action on the 3 destructive; asker_user_id + can_access on reads
- [x] surface map complete, self-check 0

## M6 - Workers + Bolt events (7 jobs, delegate)
- [x] bulwark-extract, bulwark-radar-sweep (+ pending-inbox drain), bulwark-fire-on-event, bulwark-state-reconcile, bulwark-proposal-reconcile, bulwark-gate-reconcile, bulwark-retention
- [x] 6 Bolt events in event-catalog.ts; check-bolt-catalog 0
- [x] bolt-api bulwark-dispatch-hook + sending-end outbox; worker env

## M7 - Frontend SPA (b3 shell + Bureau, delegate)
- [x] shared shell + Bureau widget; pages: obligation ledger, deadline radar, drafted-notice review queue, vendor compliance matrix, contract detail, settings

## M8 - Launchpad + infra wiring
- [x] Launchpad shield-check icon + catalog row; docker-compose bulwark-api + frontend.depends_on + BRAID_API_INTERNAL_URL; nginx x2 + railway regen; frontend Dockerfile 4 sites; services.mjs + BULWARK_API_URL (+ BASIS/BRAID backfill); visibility.service.ts bulwark.contract/obligation/deadline branches; CLAUDE.md
- [x] permission catalog: 12 hand-authored bulwark.* rows + codegen + delta + built-in-group-defaults migration

## M9-M11 - Docs, screenshots, marketing (delegate)
- [x] help.md + help-index.json + Help Center + guide.md; gilligan seed + screenshots; site/ section + MCP counts

## Phase 4 - tests + close-out (gating)
- [x] typecheck/test/db:check/lint:migrations/check-bolt-catalog/surface-map self-check
- [x] Playwright user stories (gilligan) + backend verification; MCP parity spot-check
- [x] close-out skill audit; branch CI green
