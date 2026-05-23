# Wave D Phase 3 — Satellites A wiring report

Wired four plugin-style satellites (bench-api, book-api, blast-api, bill-api)
to the shared @bigbluebam/permissions HTTP plugin, mirroring the blank-api
pilot from the same session. All builds clean, all runtimes report
`permissions plugin registered` (mode=warn), all `/<app>/api/health`
endpoints return 200.

## Per-satellite summary

### bench-api

- **Files touched**
  - `apps/bench-api/package.json` — added `@bigbluebam/permissions` workspace dep
  - `apps/bench-api/Dockerfile` — added permissions COPY in deps/build/dev stages + build step
  - `apps/bench-api/src/env.ts` — added `INTERNAL_SERVICE_SECRET` (was missing) and `BBB_PERMISSIONS_ENFORCE`
  - `apps/bench-api/src/plugins/permissions.ts` — new, registers `httpPermissionsPlugin`
  - `apps/bench-api/src/middleware/dual-read.ts` — new, re-exports `dualReadGate`/`shadowOnly`
  - `apps/bench-api/src/server.ts` — registered permissions plugin after auth plugin
  - `apps/bench-api/src/routes/materialized-views.routes.ts` — added dual-read import + 1 wrap
  - `apps/bench-api/src/routes/reports.routes.ts` — added dual-read import + 5 wraps
  - `docker-compose.yml` (bench-api block) — added `BBB_PERMISSIONS_ENFORCE` + `INTERNAL_SERVICE_SECRET` env entries
- **Gates wrapped (6)**
  - POST /materialized-views/:viewName/refresh → `bench.materialized_view_refresh.create`
  - GET /reports → `bench.report.list`
  - POST /reports → `bench.report.create`
  - PATCH /reports/:id → `bench.report.update`
  - DELETE /reports/:id → `bench.report.delete`
  - POST /reports/:id/send-now → `bench.report_send_now.create`
- **Build status:** clean (`bigbluebam-bench-api Built`)
- **Runtime status:** `bench-api permissions plugin registered` (mode=warn); listening on 4011; health 200

### book-api

- **Files touched**
  - `apps/book-api/package.json` — added permissions dep
  - `apps/book-api/Dockerfile` — added permissions COPY + build step
  - `apps/book-api/src/env.ts` — added `BBB_PERMISSIONS_ENFORCE` (`BBB_API_INTERNAL_URL` and `INTERNAL_SERVICE_SECRET` already present)
  - `apps/book-api/src/plugins/permissions.ts` — new
  - `apps/book-api/src/middleware/dual-read.ts` — new
  - `apps/book-api/src/server.ts` — registered permissions plugin after auth plugin
  - `apps/book-api/src/routes/calendars.routes.ts` — added dual-read import + 3 wraps
  - `apps/book-api/src/routes/booking-pages.routes.ts` — added dual-read import + 3 wraps
  - `apps/book-api/src/routes/events.routes.ts` — added dual-read import + 3 wraps
  - `docker-compose.yml` (book-api block) — added two env entries
- **Gates wrapped (9)**
  - POST /calendars → `book.calendar.create`
  - PATCH /calendars/:id → `book.calendar.update`
  - DELETE /calendars/:id → `book.calendar.delete`
  - POST /booking-pages → `book.booking_page.create`
  - PATCH /booking-pages/:id → `book.booking_page.update`
  - DELETE /booking-pages/:id → `book.booking_page.delete`
  - POST /events → `book.event.create`
  - PATCH /events/:id → `book.event.update`
  - DELETE /events/:id → `book.event.delete`
- **Build status:** clean (`bigbluebam-book-api Built`)
- **Runtime status:** `book-api permissions plugin registered` (mode=warn); listening on 4012; health 200

### blast-api

- **Files touched**
  - `apps/blast-api/package.json` — added permissions dep
  - `apps/blast-api/Dockerfile` — added permissions COPY + build step
  - `apps/blast-api/src/env.ts` — added `BBB_PERMISSIONS_ENFORCE`
  - `apps/blast-api/src/plugins/permissions.ts` — new
  - `apps/blast-api/src/middleware/dual-read.ts` — new
  - `apps/blast-api/src/server.ts` — registered permissions plugin after auth plugin
  - `apps/blast-api/src/routes/segments.routes.ts` — dual-read import + 3 wraps
  - `apps/blast-api/src/routes/sender-domains.routes.ts` — dual-read import + 3 wraps
  - `apps/blast-api/src/routes/templates.routes.ts` — dual-read import + 4 wraps
  - `apps/blast-api/src/routes/campaigns.routes.ts` — dual-read import + 7 wraps
  - `docker-compose.yml` (blast-api block) — added two env entries
- **Gates wrapped (17)**
  - POST /segments → `blast.segment.create`
  - PATCH /segments/:id → `blast.segment.update`
  - DELETE /segments/:id → `blast.segment.delete`
  - POST /sender-domains → `blast.sender_domain.create`
  - POST /sender-domains/:id/verify → `blast.sender_domain.verify`
  - DELETE /sender-domains/:id → `blast.sender_domain.delete`
  - POST /templates → `blast.template.create`
  - PATCH /templates/:id → `blast.template.update`
  - DELETE /templates/:id → `blast.template.delete`
  - POST /templates/:id/duplicate → `blast.template.duplicate`
  - POST /campaigns → `blast.campaign.create`
  - PATCH /campaigns/:id → `blast.campaign.update`
  - DELETE /campaigns/:id → `blast.campaign.delete`
  - POST /campaigns/:id/send → `blast.campaign.send`
  - POST /campaigns/:id/schedule → `blast.campaign_schedule.create`
  - POST /campaigns/:id/pause → `blast.campaign_pause.create`
  - POST /campaigns/:id/cancel → `blast.campaign.cancel`
- **Build status:** clean (`bigbluebam-blast-api Built`)
- **Runtime status:** `blast-api permissions plugin registered` (mode=warn); listening on 4010; health 200

### bill-api

- **Files touched**
  - `apps/bill-api/package.json` — added permissions dep
  - `apps/bill-api/Dockerfile` — added permissions COPY + build step
  - `apps/bill-api/src/env.ts` — added `BBB_PERMISSIONS_ENFORCE`
  - `apps/bill-api/src/plugins/permissions.ts` — new
  - `apps/bill-api/src/middleware/dual-read.ts` — new
  - `apps/bill-api/src/server.ts` — registered permissions plugin after auth plugin
  - `apps/bill-api/src/routes/expenses.routes.ts` — dual-read import + 6 wraps
  - `apps/bill-api/src/routes/invoices.routes.ts` — dual-read import + 12 wraps
  - `apps/bill-api/src/routes/clients.routes.ts` — dual-read import + 3 wraps
  - `apps/bill-api/src/routes/settings.routes.ts` — dual-read import + 1 wrap
  - `apps/bill-api/src/routes/payments.routes.ts` — dual-read import + 2 wraps
  - `apps/bill-api/src/routes/rates.routes.ts` — dual-read import + 3 wraps
  - `apps/bill-api/src/routes/reports.routes.ts` — dual-read import + 4 wraps
  - `docker-compose.yml` (bill-api block) — added two env entries
- **Gates wrapped (31)**
  - POST /expenses → `bill.expense.create`
  - PATCH /expenses/:id → `bill.expense.update`
  - DELETE /expenses/:id → `bill.expense.delete`
  - POST /expenses/:id/approve → `bill.expense.approve`
  - POST /expenses/:id/reject → `bill.expense.reject`
  - POST /expenses/:id/receipt → `bill.expense_receipt.create`
  - POST /invoices → `bill.invoice.create`
  - PATCH /invoices/:id → `bill.invoice.update`
  - DELETE /invoices/:id → `bill.invoice.delete`
  - POST /invoices/:id/line-items → `bill.invoice_line_item.create`
  - PATCH /invoices/:id/line-items/:itemId → `bill.invoice_line_item.update`
  - DELETE /invoices/:id/line-items/:itemId → `bill.invoice_line_item.delete`
  - POST /invoices/:id/finalize → `bill.invoice.finalize`
  - POST /invoices/:id/send → `bill.invoice.send`
  - POST /invoices/:id/void → `bill.invoice_void.create`
  - POST /invoices/:id/duplicate → `bill.invoice.duplicate`
  - POST /invoices/from-time-entries → `bill.invoice_from_time_entry.create`
  - POST /invoices/from-deal → `bill.invoice_from_deal.create`
  - POST /clients → `bill.client.create`
  - PATCH /clients/:id → `bill.client.update`
  - DELETE /clients/:id → `bill.client.delete`
  - PUT /settings → `bill.setting.update`
  - POST /invoices/:id/payments → `bill.invoice_payment.create`
  - DELETE /payments/:id → `bill.payment.delete`
  - POST /rates → `bill.rate.create`
  - PATCH /rates/:id → `bill.rate.update`
  - DELETE /rates/:id → `bill.rate.delete`
  - GET /reports/revenue → `bill.report_revenue.list`
  - GET /reports/outstanding → `bill.report_outstanding.list`
  - GET /reports/profitability → `bill.report_profitability.list`
  - GET /reports/overdue → `bill.report_overdue.list`
- **Build status:** clean (`bigbluebam-bill-api Built`)
- **Runtime status:** `bill-api permissions plugin registered` (mode=warn); listening on 4014; health 200

## Anomalies

- **bench-api env.ts lacked `INTERNAL_SERVICE_SECRET`** before this pass; the
  blank-api pilot's plugin template requires it. Added with the same
  `z.string().min(32).optional()` schema as the other three satellites.
  Already-present `BBB_API_INTERNAL_URL` was untouched.
- **No 502 after compose up:** the initial HTTPS health probe returned 502
  because nginx had cached the old upstream container IPs. `docker compose
  restart frontend` cleared it and all four returned 200. This was a
  side-effect of `--force-recreate`, not a satellite-side regression. Worth
  noting in case future Wave D rollouts hit it.
- **No mismatched manifest entries:** every wrapped route had a corresponding
  permission_id in `docs/permissions-action-manifest.json`. The lookup
  command in the task brief worked for every method+path combination.
- **No route files in unexpected locations:** all four satellites follow the
  apps/<name>-api/src/routes/<resource>.routes.ts convention.
- **bench-api created `src/middleware/`**: the dir didn't exist; book/blast/bill
  already had it (carrying `authorize.ts` for legacy use). Mkdir then
  Write — no other layout differences.

## Totals

| Metric | Value |
| --- | --- |
| Satellites wired | 4 |
| Files created | 8 (4 × `plugins/permissions.ts`, 4 × `middleware/dual-read.ts`) |
| Files modified | 33 (4 × package.json + 4 × Dockerfile + 4 × env.ts + 4 × server.ts + 1 × docker-compose.yml + 16 route files) |
| Total dualReadGate wraps | **63** (bench 6, book 9, blast 17, bill 31) |
| Catalog drift check | clean (1047 DB rows, 2 artifacts) |
| Build failures | 0 |
| Runtime failures | 0 |
| HTTPS health probes 200 | 4 / 4 |
