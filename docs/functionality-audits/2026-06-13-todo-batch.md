# ToDo batch — 2026-06-13 (unattended)

Source: `docs/incoming/BigBlueBam ToDo 2026-06-13.md`. Working branch: `todo/2026-06-13-batch`.
Running decisions/progress log — updated as each item lands. Each fix is verified locally (typecheck + unit tests where they exist) before commit; a Docker rebuild + smoke pass is run at the end. Nothing is pushed to prod branches.

## Status board

| # | Item | App | Type | Status | Commit |
|---|------|-----|------|--------|--------|
| 1 | Message 3-dots menu flashes & closes instantly | Banter | bug | ✅ done | `52cd25b7` |
| 2 | Rebuild mis-configured Bolt templates (+ agent-in-loop audit) | Bolt | rework + audit | ✅ done | `945cec74` |
| 3 | "Add many" channels via right-click on "+" | Banter | feature | ✅ done | `01488d8f` |
| 4 | Analytics → black screen | Bond | bug | ✅ done | `ad952d9b` |
| 5 | SMTP settings placeholder → role-aware guidance | Blast | UX fix | ✅ done | `8ec24a02` |
| 6 | Default "Bureau" metrics not tracking real activity | Bench | bug/data | ✅ done | `ff5efa05` |
| 7 | Booking pages ↔ Bond integration (strategy only) | Book | strategy doc | ✅ done | doc below |

Approach: a 7-agent read-only investigation swarm produced grounded root-cause + fix plans; surgical fixes (#1, #5) + the strategy doc (#7) were done directly; the larger code items (#2/#3/#4/#6) are delegated to per-app implementation agents (no git, self-typecheck) and reviewed + committed here.

## Decisions log

### 1. Banter message menu — ✅ `52cd25b7`
- **Root cause:** the hover action bar (incl. the Radix more-menu) was gated on a React `hovered` flag. The menu content is portaled to `document.body`, so opening it moved the pointer off the row → `onMouseLeave` → `setHovered(false)` → the whole bar (and the open menu) unmounted on the next render. Hence the flash-and-vanish.
- **Decision:** keep the bar always mounted; drive visibility via CSS (`group-hover`/`focus-within`) + a controlled `menuOpen` state. Chosen over the smaller "gate on `(hovered||menuOpen)`" because the CSS approach has no stuck-state edge cases. Added a regression test asserting the bar survives the `mouseleave` that used to unmount it.
- **Verify:** banter typecheck ✓, biome ✓ (only pre-existing `<button type>` warnings), 15/15 banter component tests ✓.

### 2. Bolt templates — ✅ `945cec74` (audit: `docs/functionality-audits/bolt-templates-audit-2026-06-13.md`)
- **Root cause (from investigation):** two systemic bugs across the 16 catalog templates — (A) condition fields omit the required `event.` prefix (eval wraps the payload as `{event, actor}`), so conditions never match; (B) action param keys are wrong (`banter_send_dm` needs `{to_user_id, content}` not `{user_id, message}`; `banter_post_message` needs `{channel_id, content}`). Plus invalid enums (`critical`), non-existent events (`deal.status_changed`), non-existent tools, and `{{actor.name}}` (undefined in actions). `scripts/seed-bolt.sql` has 12 more automations referencing 4 unregistered tools + a deliberately-failed sample.
- **Decision:** rebuild the ~11 fixable templates against the real event/action/operator catalog; the 5 that need data not in the event payload (`brief_approved_to_beacon`, `new_member_onboard`, `close_ticket_on_task_complete`, `bond_deal_close_invoice`, real `weekly_status_update`) are flagged as **agent-in-the-loop** and documented in `docs/functionality-audits/bolt-templates-audit-2026-06-13.md`. Fix the seed's unregistered tool names too.

### 3. Banter "Add many" — ✅ `01488d8f`
- **Root cause / constraint:** no bulk create exists; `POST /v1/channels` is rate-limited to **5/hour per user**, so a client-side loop is non-viable.
- **Decision:** add a `POST /v1/channels/bulk` endpoint (per-row results, duplicate→`23505` mapped to a per-row "duplicate" instead of a 500, batch cap, same `banter.channel.create` gate + own rate-limit budget) + a right-click "Add many" dialog gated on `useCan('banter.admin_setting.update')`. Note: the existing single-create path maps a duplicate slug to a 500 (sharp edge) and force-renames the first channel in a fresh org to `#general` — the bulk path handles both sanely.

### 4. Bond Analytics — ✅ `ad952d9b`
- **Root cause:** `AnalyticsPage` throws during render (no error boundary anywhere in `apps/bond` → a throw blanks the whole SPA = black screen). The throw is contract drift: all six bond-api analytics endpoints return shapes the frontend types/rendering never matched (primary: reads `winLoss.top_loss_reasons.length` but the API returns `loss_reasons`). Two endpoints also require `pipeline_id` the page never sends (→ 400).
- **Decision:** fix the **frontend** to match the real bond-api shapes (lower blast radius than changing the API, which MCP bond tools may consume), null-guard all reads, skip/parametrize the `pipeline_id`-required queries, and add a React **error boundary** so a future drift degrades one page instead of blanking Bond.

### 5. Blast SMTP — ✅ `8ec24a02`
- **Root cause:** the page was a fake placeholder with disabled inputs and a false claim that SMTP lives in blast-api env vars. SMTP is actually a platform-wide `system_settings.smtp_*` set in Bam → Account Settings → Integrations.
- **Decision:** truthful role-aware card (SuperUser → manage at Integrations + link; owner/admin → view-only + link; member → contact your admin). No backend change (role from the existing auth store). Link is the absolute `/b3/settings` (Blast is a separate SPA); the Integrations tab can't be deep-linked so the copy says to click it.

### 6. Bench/Bureau metrics — ✅ `ff5efa05`
- **Root cause:** three stacking defects, the first fatal — (A) `query.service.ts` hardcodes the tenant filter as `organization_id`, but every Bureau table uses `org_id`, so every Bureau widget errors `42703` and returns nothing; (B) the date filter only applies when a `time_dimension` is set (the Bureau widgets set only `date_range`); (C) the KPI widget uses an unrecognized `last_1_days` preset. Plus a data-freshness reality: `bureau_floor_analytics` is a nightly rollup of *yesterday*, and the rollup's INNER JOIN drops summons with a NULL `from_room_id`.
- **Decision:** make the org column per-source (`orgColumn`, default `organization_id`, `org_id` for bureau); apply `date_range` against the temporal dimension even without `time_dimension`; add the `last_1_days` preset and widen the seeded KPI window via a new idempotent migration. The rollup latency + NULL-room summons are **noted for review** (worker not changed in this batch). Side-finding: the `tasks`/`tickets` Bench sources have *no* org column at all and are silently broken too → tracked below.

### 7. Book ⇄ Bond — ✅ strategy doc: `docs/strategy/book-bond-booking-integration.md`
- **Key finding:** the integration is **already coded but silently broken** — the on-booking Bond contact create 401s on every booking (wrong/absent auth; bond-api has no internal ingress) and the error is swallowed. The doc reframes the work as "fix + finish," recommends MCP `/tools/call` (Option C) for a deterministic contact upsert + the missing `meeting` activity log, keeps `booking.created` as the Bolt extension hook, and lists phasing + open questions.

## Bugs discovered during the work (recorded so they aren't lost)

- **Book on-booking Bond sync is broken (silent 401 on every booking).** Not fixed in this batch (Book was scoped strategy-only); it's Phase 1 of the strategy doc. → follow-up.
- **Bond analytics API/frontend contract drift** across all 6 endpoints → being fixed in #4 (frontend side).
- **Bench `tasks`/`tickets` data sources have no org-scoping column** (neither `organization_id` nor `org_id`) → silently broken like Bureau was; out of scope for #6 (which fixes Bureau + the general `orgColumn` mechanism) → follow-up.
- **Banter single channel create maps a duplicate slug to HTTP 500** (raw Postgres `23505`, no 409) → the bulk endpoint (#3) handles duplicates per-row; the single route's 500 is left as a smaller follow-up.
- **`scripts/seed-bolt.sql`** references 4 unregistered tools + ships a deliberately-failed sample execution → addressed in #2.

## Verification

- **Per-item typecheck + unit tests (all green):** banter 15/15 component tests (incl. the menu regression); banter-api channels 23/23 (6 new bulk-schema); bond typecheck (no test files); bench-api 36/36 (4 new); bolt-api 117/117 + catalog-drift guard OK; blast typecheck. Every touched app `tsc --noEmit` clean.
- **Production builds (simulated prod):** `turbo run build` for all six changed apps — 13/13 tasks succeed (only the pre-existing "chunk > 500 kB" vite warning).
- **Migration 0188 applied to the live DB:** `docker compose run --rm migrate` → 1 applied; `bench_widgets` KPI preset now `last_7_days`; recorded in `schema_migrations`.
- **Docker (backend) — ✅ verified:** the three changed API images (banter-api, bench-api, bolt-api) rebuilt and recreated `--wait`-healthy. Live smoke via nginx (after `docker compose restart frontend` to re-resolve upstreams — the documented post-rebuild step): `POST /banter/api/v1/channels/bulk` → **401** (new bulk route registered + auth-gated, not 404); `POST /banter/api/v1/channels` → 401 (baseline); `GET /bolt/api/v1/templates` → 401 (live; bolt-api healthy ⇒ the rebuilt template catalog parsed without error); bench-api healthy with 0188 applied.
- **Frontend SPAs (banter/bond/blast) — ✅ rebuilt + deployed:** they build into the single `frontend` nginx image (no per-SPA compose service). The image was rebuilt and recreated; post-deploy smoke `GET /banter/`, `/bond/`, `/blast/` all → **200**. The *visual* UI behaviour (#1 menu stays open, #3 add-many dialog, #4 Bond Analytics renders, #5 Blast SMTP card) still needs a browser to confirm — exact steps are in each commit body + the session report. To redeploy after further edits: `docker compose build frontend && docker compose up -d --force-recreate frontend`.

## Open questions for human review

- **#3 bulk channels:** is the "Add many" action correctly gated on org-admin (`banter.admin_setting.update`)? Members *can* create channels one-at-a-time, so this is a UX/throttling choice, not a hard security boundary.
- **#4 Bond:** confirm the frontend-side reconciliation is preferred over changing the bond-api response shapes (some MCP bond tools read those endpoints).
- **#6 Bench:** the nightly-rollup latency means Bureau metrics appear the day *after* activity; acceptable, or do we want an intra-day rollup / a real-time `bureau.summon.issued`-driven widget?
- **#2 Bolt:** the 5 agent-in-loop templates — keep them in the catalog (marked non-functional) or remove until the agent step exists?
