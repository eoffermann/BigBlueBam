# Braid build - work in progress checklist

Spec: `docs/brainstorming/2026_07_18_13_09_APP_DESIGN_braid.md` (converged after 3 adversarial rounds).
Branch: `suite-brainstorm` (feature branches off it allowed; never merge to main/stable).
App id `braid`, api port 4020, routes `/braid/`, `/braid/api/`, `/braid/ws`.

This is the human-inspectable milestone tracker. Each milestone has an outcome and
sub-steps. Checked = landed on-branch and locally verified.

## M1 - Scaffold (`apps/braid-api` + `apps/braid`)
- [ ] `apps/braid-api` Fastify server modeled on `apps/basis-api` (server.ts, env.ts, plugins incl. basis-style `rls.ts` GUC + permissions, health plugin from `@bigbluebam/service-health`)
- [ ] `apps/braid-api` package.json, tsconfig, Dockerfile, drizzle config
- [ ] `apps/braid` React SPA scaffolded from the blip sibling (vite, tsconfig, package.json, index.html)
- [ ] typecheck both new packages green

## M2 - Data model + migrations
- [ ] Drizzle schema modules under `apps/braid-api/src/db/schema/` (6 tables + index.ts)
- [ ] `0230_braid_core.sql` (profiles, identities, survivorship_rules, org_settings, indexes, RLS, self-FKs)
- [ ] `0231_braid_candidates_decisions.sql` (match_candidates, merge_decisions, indexes, RLS)
- [ ] `docker compose run --rm migrate` applies both; verify tables via `\d`
- [ ] `pnpm db:check` + `pnpm lint:migrations` green

## M3 - Shared Zod schemas
- [ ] `packages/shared/src/schemas/braid.ts` (profile, identity, candidate, decision, rule, settings, resolve, JSONB evidence shapes)
- [ ] exported from `packages/shared` index; typecheck green

## M4 - API routes + realtime
- [ ] All `/v1` REST endpoints (Section 5.1): profiles read/list/identities/timeline/decisions, resolve, candidates list/get/merge/reject, profiles merge/split, survivorship-rules get/put, settings get/patch, internal/events, health/readyz
- [ ] per-viewer attribute re-assembly + can_access preflight on read paths
- [ ] the single `mergeCandidate`/`rejectCandidate` executors (CAS-guarded, transactional)
- [ ] all-keys advisory-lock helper (shared by resolve + worker)
- [ ] `proposal.decided` Bolt subscription (branch on decision, kill-switch + tier recheck)
- [ ] `/braid/ws` realtime (Redis PubSub, refs-only frames)
- [ ] source-type enablement gate

## M5 - MCP tool surface at full parity (13 tools)
- [ ] `apps/mcp-server/src/tools/braid-tools.ts` - 13 tools via `registerTool`
- [ ] `braid.*` agent_policies allowlist; confirm_action on merge/split
- [ ] read tools take `asker_user_id`, fail-closed via can_access
- [ ] `search_everything` Braid provider (admin-asker, per-viewer post-filter)
- [ ] `docs/reference/mcp-endpoint-mapping.md` rows for every endpoint (tool or sanctioned skip); self-check grep prints 0
- [ ] UI-action cross-walk (every SPA action has a tool)

## M6 - Workers + Bolt events
- [ ] `braid-match-on-ingest` (normalize, block, score, band, N-way bridge; retry/backoff/DLQ)
- [ ] `braid-rescan` (source-diffing, outbox reconcile, progress logging)
- [ ] `braid-proposal-reconcile` (10-min sweep, at-least-once)
- [ ] `braid-candidate-retention` (daily purge)
- [ ] 4 Bolt events registered in `event-catalog.ts`; `check-bolt-catalog.mjs` green
- [ ] worker compose env (`QDRANT_URL`, `BBB_API_INTERNAL_URL`)

## M7 - Frontend SPA (matches `/b3/` shell + Bureau widget)
- [ ] shared sidebar + top bar + Launchpad + blue theme tokens (copy blip)
- [ ] Bureau widget mounted in main.tsx; PermissionsProvider + auth store
- [ ] Profile catalog page
- [ ] Golden-profile detail (cross-app timeline, members, decisions)
- [ ] Merge review queue (confirm/reject)
- [ ] Survivorship rules editor
- [ ] Settings page (thresholds, enabled sources)

## M8 - Launchpad + infra wiring
- [ ] Launchpad catalog row + `git-merge` icon in `packages/ui/launchpad.tsx`
- [ ] docker-compose `braid-api` service + `frontend.depends_on` + worker env
- [ ] nginx.conf + nginx-with-site.conf blocks + static-asset regex; regenerate railway
- [ ] frontend Dockerfile 4 sites; services.mjs catalog; gen-railway-configs
- [ ] visibility.service.ts branches (bill.client, helpdesk.user, book.event_attendee, braid.profile, braid.identity)
- [ ] CLAUDE.md inventory + route rows + MCP count bump (+13, 51 modules)

## M9 - Docs (help doc format + index)
- [ ] `docs/apps/braid/help.md` (help-doc-authoring standard)
- [ ] `help-index.json` built; Help Center wired
- [ ] `docs/apps/braid/guide.md`
- [ ] surface map + mcp count updated

## M10 - Screenshots (gilligan only)
- [ ] gilligan Braid seed data (Skipper as bond.contact + bill.client + book attendees)
- [ ] capture catalog, detail, review-queue (light + dark)

## M11 - Marketing site
- [ ] `site/` Braid section/card
- [ ] MCP tool counts updated on the marketing site

## Tests (Phase 4, gating)
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm db:check`, `pnpm lint:migrations`, `check-bolt-catalog.mjs`, surface-map self-check
- [ ] Playwright user stories (gilligan) + backend verification (rows + Bolt events)
- [ ] MCP parity spot-check driven through tools alone
- [ ] branch CI green
