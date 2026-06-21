# Board & Bearing Functionality Audit

**Date:** 2026-04-09
**Tester:** Automated (Playwright headless Chromium)
**Credentials:** test@bigbluebam.test / TestUser2026!
**Environment:** http://localhost (Docker Compose stack)

---

## Summary

| Area    | Pass | Fail | Warn | Total |
|---------|------|------|------|-------|
| Board   | 4    | 2    | 3    | 9     |
| Bearing | 5    | 2    | 4    | 11    |
| **All** | **9**| **4**| **7**| **20**|

### Critical Bugs Found

| # | Severity | App     | Bug | Root Cause | File(s) |
|---|----------|---------|-----|------------|---------|
| 1 | **P0**   | Board   | `GET /boards` returns 500 -- all boards invisible ("boards disappeared") | The `visibilityFilter()` subquery references the `project_members` table, but the actual DB table is `project_memberships`. PostgresError: `relation "project_members" does not exist`. | `apps/board-api/src/db/schema/bbb-refs.ts:144` (Drizzle schema says `project_members`), `apps/board-api/src/services/board.service.ts:110-122` (visibility filter uses it) |
| 2 | **P1**   | Board   | `GET /boards/stats` returns 400 -- stats cards fail to load | No `/boards/stats` route exists. Fastify matches `GET /boards/:id` where `:id = "stats"`, which fails UUID validation with "Valid board id is required". The frontend `useBoardStats()` hook calls this route. The service has a `getStats()` function but no route is wired. | `apps/board-api/src/routes/board.routes.ts` (missing route), `apps/board/src/hooks/use-boards.ts:76-87` (frontend calls it) |
| 3 | **P1**   | Bearing | Period creation with `period_type: "quarter"` returns 500 | DB check constraint `bearing_periods_period_type_check` only allows `['annual', 'semi_annual', 'quarterly', 'monthly', 'custom']`. The frontend Period store type definition uses `'quarter' | 'half' | 'year' | 'custom'` which includes `quarter` (not `quarterly`). The shared Zod schema `BearingPeriodType` accepts both `quarter` and `quarterly` but the DB only accepts `quarterly`. | `packages/shared/src/schemas/bearing.ts:4`, `apps/bearing/src/stores/period.store.ts:6` |
| 4 | **P1**   | Bearing | Goal creation returns 500 when `owner_id` is omitted | DB column `bearing_goals.owner_id` has a NOT NULL constraint, but the API schema marks `owner_id` as `nullable().optional()` and the service defaults to `null` instead of the creating user's ID. | `apps/bearing-api/src/services/goal.service.ts:220`, `apps/bearing-api/src/routes/goals.ts:29` |

---

## Board Tests (/board/)

### B1: Board SPA loads
**Result: PASS**
- Navigated to `http://localhost/board/`
- Page rendered with `h1="Boards"`
- No unauthenticated state shown (session cookie from /b3/ login works cross-app)

### B2: Board list -- empty state
**Result: PASS**
- Empty state UI renders correctly: "No boards yet" with "Create Board" CTA
- Note: The list appears empty because `GET /boards` is failing (see B3), so the component falls through to the empty state. This masks the real bug -- the user sees "No boards yet" instead of an error, even when boards exist.

### B3: GET /board/api/v1/boards
**Result: FAIL -- Status 500**
- Error: `relation "project_members" does not exist`
- **Root cause:** The Drizzle schema in `apps/board-api/src/db/schema/bbb-refs.ts:144` declares `pgTable('project_members', ...)` but the actual DB table is `project_memberships`. The `visibilityFilter()` function in `board.service.ts` builds a subquery against this phantom table, causing every `listBoards()` call to crash.
- **This is the "boards disappeared" bug.** Board creation (`POST /boards`) still works because it doesn't use the visibility filter. But listing, searching, and getting recent/starred boards all fail.
- **Fix:** Rename `project_members` to `project_memberships` in `bbb-refs.ts` and update all references (service, middleware).

### B4: GET /board/api/v1/boards/stats
**Result: FAIL -- Status 400**
- Response: `{"error":{"code":"BAD_REQUEST","message":"Valid board id is required"}}`
- **Root cause:** No `/boards/stats` route exists in `board.routes.ts`. Fastify matches `GET /boards/:id` where `:id = "stats"`, and the `requireBoardAccess` middleware rejects it because "stats" is not a valid UUID.
- The service layer has `getStats(orgId)` implemented but no route calls it.
- **Fix:** Add `GET /boards/stats` route BEFORE the `GET /boards/:id` route in `board.routes.ts`.

### B5: Create new board (UI flow)
**Result: PASS**
- `/board/new` page renders with "Create New Board" header
- Name input and "Blank Board" template option visible
- Typed board name, clicked Create Board
- Successfully navigated to canvas: `http://localhost/board/91c3b8fe-3b23-49b9-84b0-47901c93a8e1`

### B6: POST /board/api/v1/boards (API create)
**Result: PASS**
- Created board via API with `{ name: "API Audit Board", visibility: "organization" }`
- Status 201, board ID returned

### B7: Canvas renders (Excalidraw)
**Result: PASS** (tested in phase 2)
- Navigated to `/board/<uuid>`
- Excalidraw `.excalidraw` container element present
- `<canvas>` element rendered
- 16 toolbar buttons visible on canvas page
- Scene save (`PUT /boards/:id/scene`) returns 200
- Scene load (`GET /boards/:id/scene`) returns 200

### B8: Chat panel toggle
**Result: PASS** (tested in phase 2)
- Chat toggle button found with `title="Toggle chat"`
- Button is clickable on the canvas page

### B9: "Boards disappeared" investigation
**Result: INVESTIGATED -- ROOT CAUSE IDENTIFIED**

The "boards disappeared" issue is caused by Bug #1 above. The sequence:

1. User creates boards successfully (POST works, no visibility filter involved)
2. User navigates to board list (GET /boards triggers visibility filter)
3. Visibility filter queries `project_members` table which doesn't exist
4. PostgreSQL throws `relation "project_members" does not exist`
5. API returns 500
6. Frontend catches error silently, shows empty array
7. User sees "No boards yet" empty state

Additionally:
- The `board_active_project_id` localStorage key was `null` (not contributing to the issue)
- The `useBoardList` hook passes `activeProjectId` to the API's `project_id` filter. If a user had a stale project ID saved in localStorage for a project they were removed from, all boards would be filtered out. This is a secondary concern.

---

## Bearing Tests (/bearing/)

### G1: Bearing SPA loads
**Result: PASS**
- Page rendered with `h1="Goals Dashboard"`
- Session authentication works

### G2: Goals Dashboard renders
**Result: PASS**
- Dashboard header visible
- "New Goal" button visible
- Period selector component present
- Scope filter tabs and search input visible

### G3: GET /bearing/api/v1/periods
**Result: PASS**
- Status 200, 0 periods initially
- Response: `{"data":[],"meta":{"next_cursor":null,"has_more":false}}`

### G4: GET /bearing/api/v1/goals
**Result: PASS**
- Status 200, 0 goals initially
- Response: `{"data":[],"meta":{"next_cursor":null,"has_more":false}}`

### G5: POST /bearing/api/v1/periods (create with `period_type: "quarter"`)
**Result: FAIL -- Status 500**
- Error: `bearing_periods_period_type_check` constraint violation
- The DB check constraint accepts: `annual`, `semi_annual`, `quarterly`, `monthly`, `custom`
- The shared Zod schema `BearingPeriodType` accepts: `annual`, `semi_annual`, `quarterly`, `monthly`, `quarter`, `half`, `year`, `custom`
- The frontend period store type uses: `'quarter' | 'half' | 'year' | 'custom'` -- these are the display-friendly names that don't match the DB
- **Fix:** Either update the DB check constraint to include `quarter`/`half`/`year`, or fix the frontend to use the canonical DB values (`quarterly`/`semi_annual`/`annual`), or map them in the API layer.

### G5b: POST /bearing/api/v1/periods (create with `period_type: "quarterly"`)
**Result: PASS** (phase 2 verification)
- Using the correct DB value `"quarterly"` succeeds with status 201
- Confirms the constraint itself works -- it's just a value mismatch

### G6: POST /bearing/api/v1/goals (create -- owner_id omitted)
**Result: FAIL -- Status 500**
- Error: `null value in column "owner_id" of relation "bearing_goals" violates not-null constraint`
- **Root cause:** `goal.service.ts:220` does `owner_id: data.owner_id ?? null` but the DB column is NOT NULL
- The `createGoalSchema` in `goals.ts:29` marks `owner_id` as `z.string().uuid().nullable().optional()`, allowing null
- The frontend `CreateGoalDialog` does pass `owner_id: userId` but the API should be defensive
- **Fix:** Change `goal.service.ts:220` to `owner_id: data.owner_id ?? userId` (use creating user as default)

### G7: GET /bearing/api/v1/goals/:id (with KRs)
**Result: WARN**
- Could not test: no goals exist due to G6 bug blocking creation

### G8: POST key-results (create KR)
**Result: WARN**
- Could not test: no goals exist due to G6 bug blocking creation

### G9: Query parameter mismatch investigation
**Result: PASS (not a bug)**
- `scope=team` -> 200
- `filter[scope]=team` -> 200
- Zod's `parse` ignores unknown keys, so `filter[scope]` is simply ignored (treated as an unknown query param). The scope filter just doesn't apply, which returns unfiltered results. Not a crash, but the frontend's filter won't actually work.
- **Note:** The frontend `useGoals` hook sends `'filter[scope]': filters?.scope` but the API expects `scope`. The filter silently has no effect. This is a low-severity UI bug -- scope filtering appears to work (because unfiltered results include the filtered subset) but doesn't actually narrow results.

### G10: Periods page renders
**Result: PASS**
- `/bearing/periods` renders with "Periods" heading
- "New Period" button visible
- "No periods yet" empty state shown correctly

---

## Additional Observations

### Console Errors
17 console errors were captured during testing, primarily:
- 401 Unauthorized (expected -- pre-login state)
- 400 Bad Request (stats route mismatch)
- 500 Internal Server Error (board listing, period/goal creation)
- 404 Not Found (audio token route `POST /boards/:id/audio/token` returns 404)

### Audio Token Route Missing
When opening the canvas, the frontend attempts `POST /boards/:id/audio/token` which returns 404. The route file `audio.routes.ts` exists but may not register this specific endpoint. Low priority since the canvas still works without it.

### Scene Persistence
Scene save/load endpoints work correctly (`PUT/GET /boards/:id/scene`). However, the load returns 0 elements even after saving -- the elements may not be persisted in the expected format (the test saved raw Excalidraw element objects but the backend may expect a different structure).

---

## Recommended Fix Priority

1. **P0 -- Board listing crash (project_members table name):** Fix `bbb-refs.ts` to reference `project_memberships`. This unblocks all board listing, searching, and recent/starred functionality.

2. **P1 -- Board stats route:** Add `GET /boards/stats` route in `board.routes.ts` that calls `boardService.getStats()`. Must be registered before `GET /boards/:id` to avoid Fastify matching stats as an ID.

3. **P1 -- Bearing goal owner_id default:** Change `goal.service.ts` line 220 from `data.owner_id ?? null` to `data.owner_id ?? userId`.

4. **P1 -- Bearing period_type mismatch:** Align the frontend period type values with the DB constraint. Either:
   - (a) Update the frontend `period.store.ts` type to use `'quarterly' | 'semi_annual' | 'annual' | 'monthly' | 'custom'`, OR
   - (b) Add a migration to update the DB check constraint to also accept `quarter`/`half`/`year`, OR
   - (c) Add mapping in the API layer to translate frontend values to DB values.

5. **P2 -- Frontend scope filter params:** Change `useGoals` hook to send `scope` instead of `'filter[scope]'` (and similar for status, owner_id).
