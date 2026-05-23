# Remaining Work (2026-04-16, rev 2)

Updated after the P0+P1+P2 and deferrals passes completed. Nearly all items from rev 1 are now closed. Only genuine follow-ups and infra items remain.

---

## Closed since rev 1

All P0 items closed. All P1 items closed (or have working backend + frontend connected). All P2 items closed except 3 noted below. Seeding, docs, cross-product, and infrastructure items closed.

## Still open

### Infrastructure
- [P0] **CI standardization.** Record as future validation check. `pnpm install`, `typecheck`, `test`, `lint:migrations`, `db:check` on Linux have not run against `recovery`. `.github/workflows/migration-replay.yml` now exists and can be tested once CI is configured.
- [P1] **Kubernetes Helm chart at `infra/helm/bigbluebam/`.** The Tier 4 deployment target in `docs/guides/deployment.md` and `docs/reference/BigBlueBam_Design_Document.md` §20.7 is referenced as if it exists, but the `infra/helm/` directory does not exist. Authoring is needed before the docs can be honest about Tier 4. Scope: ~14 Deployments (api, mcp-server, worker, frontend, 12 satellite apis) with Services and HPAs, ConfigMaps + Secrets for env vars, Ingress for /b3/ /banter/ /helpdesk/ /mcp/ etc., a postgres StatefulSet (or "managed postgres only" values mode), a Redis StatefulSet, and a `migrate` Job that runs to completion as an init dependency. Reference: the live `docker-compose.yml` (the source of truth for service shape, env vars, and dependency order) and the Tier 4 sketch in the design doc. The Railway adapter already proves the app code is k8s-ready (env-driven config, Redis pubsub cross-replica, stateless services); this is mostly YAML authoring + testing on minikube/kind. Estimated effort: 1-2 weeks of focused work plus a real cluster test pass. Open question recorded in `docs/design-audits/2026-04-14/Platform_Design_Audit.md` #5 since 2026-04-14 — this entry resolves the question by setting a priority.
- [P2] **Activity log partitioning.** Plain table works; partitioning is a scaling concern for later.

### Platform
- [P2] **Admin UI for OAuth provider configuration.** Providers are seeded via DB; no UI.
- [P2] **Bam admin UI for Helpdesk default project.** MCP tool + PATCH endpoint cover it; `/b3/settings/helpdesk` page deferred.

### Per-App
- [P2] **Board spatial clustering endpoint.** `GET /v1/boards/:id/clusters` with grid-based or k-means grouping.
- [P2] **Bench manager role relaxation.** Requires migration + auth-model changes across 14 services. Not a 1-line fix.
- [P2] **Bearing PDF export.** Needs headless renderer (Puppeteer or Playwright). CSV export shipped.
- [P2] **Bill time-entry-to-invoice wizard.** Cross-app UX linking Bam time entries to Bill line items.
- [Cleanup] **db-stubs full rollout.** 2 of 13 bbb-refs.ts files replaced. Remaining 11 need case-by-case review for domain-specific extra tables.
- [Cleanup] **Brief Tiptap extension data wiring.** Extensions are in the editor but Mention and SlashCommand use empty item lists. Need API calls for real user/channel suggestions.
- [Cleanup] **Board thumbnail MinIO upload.** Currently stored as base64 data URIs. Should upload to MinIO for production scale.
- [Cleanup] **Brief real embedding model.** Currently uses zero-vector stubs. Needs an actual embedding model endpoint.

### Helpdesk
- [DESIGN-DECISION] **Host-based subdomain routing** deferred per D-010.

### MCP Server
- [P2] **MCP_INTERNAL_API_TOKEN provisioning automation.** Currently manual via CLI.

### Seeding
- [Cleanup] **Mention popup data.** Brief @mention and #channel-link suggestions need real API data, not empty defaults.

## Completed items summary (this pass)

- Brief P0 Hocuspocus collaboration + 7 Tiptap extensions wired + 3 background jobs + Qdrant search
- Banter P0 voice agent + STT + rich embeds + link previews + unread sync + retention + partition migration
- Platform: unified error handler (14 services) + health probes (14 services) + db-stubs enriched + API key grace period
- Beacon: graph explorer already complete + freshness badges (P2)
- Bearing: EpicPicker + TaskQueryBuilder + watcher notifications + CSV export (P2)
- Bench: saved queries CRUD + UI + date-range caching
- Bill: expense receipt upload + deal-close invoice template (P2)
- Blank: conditional routing + file validation + multi-page forms (P2)
- Blast: segment evaluation + device analytics + CAN-SPAM compliance (P2)
- Board: SVG export + PNG export (sharp) + element limits + thumbnails
- Bolt: LLM proxy + execution cleanup + automation versioning (P2)
- Bond: include_deleted + cross-link rail + bulk scoring + frontend toggle/restore/related card
- Book: timeline aggregation + auto-create on booking + frontend timeline view
- Helpdesk: agent queue + email worker + queue page in Bam + reserved slug validation (P2)
- Brief editor: all 7 extensions wired with suggestion popups
- db-stubs: enriched with auth columns + 2 services migrated
- Docs: getting-started refresh + seed-verify script + smoke-test checklist
- Infra: migration-replay CI workflow
- Cross-product: notification fan-out service wired from task.assigned
