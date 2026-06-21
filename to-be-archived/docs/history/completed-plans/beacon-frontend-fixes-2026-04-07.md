# Beacon Frontend Fix Plan

**Status:** Complete (all phases)
**Branch:** `beacon`
**Date:** 2026-04-07

When resuming, tell Claude: "Read and execute the plan in docs/beacon-frontend-fix-plan.md"

---

## Phase A — Diagnose and fix all frontend bugs

### A1. Black screens / routing failures
- Read `apps/beacon/src/app.tsx` — check parseRoute for broken patterns, missing cases, bad regex
- Read `apps/beacon/src/stores/auth.store.ts` — check if auth check is failing silently (black screen = auth gate or render crash)
- Read `apps/beacon/src/components/layout/beacon-layout.tsx` — check if layout crashes when data is missing
- Test each route manually via curl to confirm the SPA HTML loads: `/beacon/`, `/beacon/list`, `/beacon/search`, `/beacon/graph`, `/beacon/dashboard`, `/beacon/settings`, `/beacon/new`, `/beacon/b/some-slug`
- Check browser console errors by looking at the built JS for obvious issues (missing imports, undefined references)

### A2. Knowledge Graph issues
- Read `apps/beacon/src/components/graph/graph-canvas.tsx` — fix:
  - **All nodes same size:** The authority-based sizing (verification_count + inbound_link_count) is probably all zeros or not being passed. Check how node size is computed and ensure the data from the API includes these fields.
  - **Nodes overlapping / unreadable:** Force layout parameters likely need tuning — increase repulsion strength, increase minimum node distance. Read `apps/beacon/src/lib/force-layout.ts` and increase repulsion constant.
  - **Not showing enough beacons:** The hubs endpoint likely returns only top_k=20. For the graph home view, this is correct (it's the top 20 hubs), but the UI text is confusing. Fix the messaging.
- Read `apps/beacon/src/components/graph/knowledge-home.tsx` — fix the stats display

### A3. Home page stats wrong ("20 total beacons, 3 at risk, 1022 recently updated")
- Read `apps/beacon/src/pages/home.tsx` — find the queries that compute these stats
- "20 total beacons" is wrong — there are 5000. The list endpoint is probably returning paginated results (default limit=20) and the UI is reading `results.length` instead of a total count
- "1022 recently updated" — probably a similar count issue, or the query is returning too many
- Fix: use a count endpoint or read the total from the paginated response metadata

### A4. "Explore from here" → empty graph
- Read `apps/beacon/src/pages/graph-explorer.tsx` — check what happens when focalId is set
- Read `apps/beacon/src/hooks/use-graph.ts` — check `useGraphNeighbors` — is it passing the beacon ID correctly?
- Read `apps/beacon-api/src/routes/graph.routes.ts` and `apps/beacon-api/src/services/graph.service.ts` — test the neighbors endpoint directly: `curl http://localhost/beacon/api/graph/neighbors?beacon_id=<UUID>&hops=1`
- The route might be failing silently (wrong param name, missing org_id, etc.)

### A5. "View Beacon" → "Beacon not found"
- Read `apps/beacon/src/pages/beacon-detail.tsx` — check how it resolves the beacon ID from the route
- The route is `/beacon/b/:idOrSlug` — check if parseRoute extracts this correctly
- Test the API directly: `curl http://localhost/beacon/api/beacons/<id>` with session cookie
- Check if the API's getBeacon requires org_id in the cookie/session and it's not being sent
- Check `apps/beacon/src/lib/api.ts` — does it send credentials: 'include'?

### A6. General frontend health check
- Read `apps/beacon/src/hooks/use-beacons.ts` — verify all query URLs are correct (no double slashes, correct base path)
- Read `apps/beacon/src/lib/api.ts` — verify baseUrl is `/beacon/api` (not `/beacon/api/v1` or something that doesn't match the actual routes)
- Verify the beacon-api routes don't have a `/v1/` prefix that the frontend isn't sending
- Test key API endpoints with curl through nginx to confirm they work end-to-end

---

## Phase B — After frontend fixes are working

### B1. Rebuild and restart Docker containers
```bash
docker compose -f docker-compose.yml -f docker-compose.site.yml build beacon-api frontend
docker compose -f docker-compose.yml -f docker-compose.site.yml up -d --force-recreate beacon-api frontend
```

### B2. Generate Beacon screenshots
Use Playwright to capture:
1. `beacon-home.png` — Knowledge Home (http://localhost/beacon/)
2. `beacon-list.png` — Browse page (http://localhost/beacon/list)
3. `beacon-search.png` — Search with results (http://localhost/beacon/search?text=deployment)
4. `beacon-detail.png` — Single beacon detail
5. `beacon-graph.png` — Knowledge Graph explorer
6. `beacon-editor.png` — Create page (http://localhost/beacon/new)
7. `beacon-dashboard.png` — Governance dashboard (http://localhost/beacon/dashboard)

Save to `images/` and mirror to `site/public/screenshots/`.

### B3. Update marketing site
- Create `site/src/components/sections/beacon-section.tsx` following helpdesk-section.tsx pattern
- Add BeaconSection to `site/src/app.tsx`
- Update all "111" references to "140" in site/src/
- Rebuild site container

### B4. Update README.md
- Ensure Beacon section exists with screenshots
- Tool count = 140
- Docker services = 14 (include beacon-api + qdrant)

---

## Phase C — Security audit fixes

Read `docs/beacon-security-audit.md` for the full list of 23 findings. Fix in priority order:

### P0 (Critical — fix first):
1. P0-001: ILIKE search injection — escape % and _ in user input
2. P0-002: Cross-org link creation — validate target_id org matches source org
3. P0-003: Challenge IDOR — add requireBeaconReadAccess to challenge route

### P1 (High):
4. P1-001: body_markdown size limit — add max length validation
5. P1-002: Saved query org isolation
6. P1-003: retireBeacon lifecycle bypass
7. P1-004: Policy org_id override
8. P1-005: Link deletion IDOR
9. P1-006: Graph visibility filtering
10. P1-007: hybridSearch userId parameter bug
11. P1-008: Rate limiting

### P2-P3 (Medium/Low — fix after P0/P1):
- CSRF, slug collision, error leakage, MCP schema mismatches, etc.

After each priority group, run tests and commit+push.

---

## Commit + push strategy

- Commit after EACH logical fix group (not one giant commit at the end)
- Push after each commit
- Use descriptive commit messages: "beacon: fix graph node sizing and overlap", "beacon: fix home page stats queries", etc.
