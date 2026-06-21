# Investigation: Bond, Brief, Board, MCP issues (2026-04-09)

Research-only report. No code has been changed.

---

## 1. Bond — Custom Fields settings shows black screen

### Symptom
Clicking the **Custom Fields** tab in Bond Settings briefly flashes the real interface and then renders a black screen (the rest of the SPA shell stays up but the panel content unmounts via React error boundary / blank fallback).

### Root cause
Radix UI's `Select.Item` (`@radix-ui/react-select`) **forbids `value=""`** — it throws at render time:

> A `<Select.Item />` must have a value prop that is not an empty string. This is because the Select value can be set to an empty string to clear the selection and show the placeholder.

`FieldsSettings` uses an "All Types" filter option with `value: ''`:

- `apps/bond/src/pages/settings.tsx:268-309` — `FieldsSettings` declares
  ```ts
  const [entityFilter, setEntityFilter] = useState<string>('');
  ...
  <Select
    value={entityFilter}
    onValueChange={setEntityFilter}
    options={[
      { value: '', label: 'All Types' },               // <-- crashes
      ...ENTITY_TYPES.map((t) => ({ value: t.value, label: t.label })),
    ]}
    placeholder="Filter..."
  />
  ```
- `apps/bond/src/components/common/select.tsx:46-56` — wraps `RadixSelect.Item value={opt.value}`, so `value=""` is passed straight through to Radix and explodes when the popper opens / mounts items. Mounting happens immediately because `value=''` matches that item, so Radix tries to render it as the selected item on first paint — that's why the panel renders for a moment, then dies as soon as React reconciles the children of the Select.

The API endpoint, hook, and service are all healthy. Verified:

- `apps/bond/src/hooks/use-custom-fields.ts:38-47` (`useCustomFieldDefinitions`) — query is fine.
- `apps/bond/src/lib/api.ts:38-44` — already filters out empty/null params, so passing `entityFilter=''` does NOT send a bad query string.
- `apps/bond-api/src/routes/custom-fields.routes.ts:51-62` — `GET /custom-field-definitions` returns 200 with `{ data: [...] }`.
- `apps/bond-api/src/services/custom-field.service.ts:32-50` — straightforward `org_id` scoped select.

### Recommended fix
Use a non-empty sentinel value for "All Types" in the Select, and translate it to `undefined` when calling the hook:

```ts
const ENTITY_FILTER_ALL = '__all__';
const [entityFilter, setEntityFilter] = useState<string>(ENTITY_FILTER_ALL);
const { data, isLoading } = useCustomFieldDefinitions(
  entityFilter === ENTITY_FILTER_ALL ? undefined : entityFilter,
);
...
options={[
  { value: ENTITY_FILTER_ALL, label: 'All Types' },
  ...ENTITY_TYPES.map((t) => ({ value: t.value, label: t.label })),
]}
```

Audit the rest of `apps/bond/src/` for any other `<Select>` options that pass `value: ''` — same crash pattern. A grep for `value: ''` inside `Select` calls is worth doing as a follow-up. (Settings page has only this one occurrence.)

A second long-term option is to harden `apps/bond/src/components/common/select.tsx` so it filters out empty-string item values and treats them as "clear", but that just hides the API contract — better to fix at the call site.

### Files
- `D:\Documents\GitHub\BigBlueBam\apps\bond\src\pages\settings.tsx` (lines 268-315)
- `D:\Documents\GitHub\BigBlueBam\apps\bond\src\components\common\select.tsx`

---

## 2. Brief — Home shows 16 docs but Documents shows 4

### Symptom
Home dashboard "Total Documents" stat = **16**. Documents page list = **4**.

### Database evidence (mage-inc org)
```
 visibility  | has_project | count
--------------+-------------+-------
 project      | f           |     1
 project      | t           |    11
 organization | t           |     4
```
Total = 16. 4 are `organization`-visibility, 12 are `project`-visibility. (1 of those 12 has a NULL project_id, which makes it effectively unreachable through the project-membership check.)

### Root cause
The two endpoints use **different visibility logic**:

- **`GET /documents/stats`** (`apps/brief-api/src/services/document.service.ts:587-607`)
  ```sql
  SELECT COUNT(*)::int AS total ...
  FROM brief_documents
  WHERE org_id = ${orgId}
  ```
  Counts every doc in the org regardless of visibility, regardless of which projects the user belongs to. Returns 16.

- **`GET /documents`** (`apps/brief-api/src/services/document.service.ts:185-289`, `listDocuments`) enforces a visibility filter:
  - `visibility = 'organization'` (always visible to org members), OR
  - `visibility = 'private'` AND user is creator/collaborator, OR
  - `visibility = 'project'` AND user is creator/collaborator/project member.

  For a Mage Inc user who is **not** a member of the "Mage" project, only the 4 organization-visibility docs match. Returns 4.

In addition, the **Documents** page itself adds another implicit filter from the active-project store:

- `apps/brief/src/pages/document-list.tsx:25-31`
  ```ts
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  ...
  if (activeProjectId) filters.project_id = activeProjectId;
  ```
  When the user has no active project selected, `project_id` is omitted (so the visibility filter is the only narrowing). When the user has a project active, it narrows further to that project.

So the disagreement is "16 raw count of org docs" vs. "4 docs the current user is actually permitted to read". `getStats` is the broken party — it should not over-count documents the user cannot see.

### Why `useRecentDocuments` and `useStarredDocuments` look OK
- `getRecentDocuments` (line 482) and `searchDocuments` (line 525) **do** apply visibility filtering. Stats is the only outlier.

### Recommended fix
Change `getStats` to take `userId` in addition to `orgId` and apply the same visibility predicate as `listDocuments` / `getRecentDocuments`. The cleanest path:

1. Extract the visibility predicate from `listDocuments` into a shared helper (e.g., `documentVisibilityPredicate(userId)` returning a Drizzle SQL expression), and reuse it in `listDocuments`, `getRecentDocuments`, `searchDocuments`, and the new stats query.
2. Rewrite `getStats` to do
   ```sql
   SELECT
     COUNT(*)::int AS total,
     COUNT(*) FILTER (WHERE status='draft')::int AS draft,
     COUNT(*) FILTER (WHERE status='in_review')::int AS in_review,
     COUNT(*) FILTER (WHERE status='approved')::int AS approved,
     COUNT(*) FILTER (WHERE status='archived')::int AS archived
   FROM brief_documents
   WHERE org_id = $1
     AND ( <visibility predicate against $2 = userId> )
   ```
3. Update the `/documents/stats` route (`apps/brief-api/src/routes/document.routes.ts:138-146`) to pass `request.user!.id` and have the response shape unchanged.
4. Optional follow-up: also accept an optional `project_id` query param on the stats endpoint and have Home pass `activeProjectId` so the cards mirror the Documents-page filter exactly. Without this, Home and Documents will still disagree whenever the user has an active project selected.

### Files
- `D:\Documents\GitHub\BigBlueBam\apps\brief-api\src\services\document.service.ts` (lines 185-289 listDocuments, 482-523 getRecentDocuments, 587-607 getStats)
- `D:\Documents\GitHub\BigBlueBam\apps\brief-api\src\routes\document.routes.ts` (lines 138-167)
- `D:\Documents\GitHub\BigBlueBam\apps\brief\src\pages\home.tsx`
- `D:\Documents\GitHub\BigBlueBam\apps\brief\src\pages\document-list.tsx`
- `D:\Documents\GitHub\BigBlueBam\apps\brief\src\hooks\use-documents.ts` (no client change required if the response shape stays the same)

---

## 3. Board — Total Boards stat shows 10 but only 2 boards listed

### Symptom
Board list page header card "Total Boards" = **10**, but the grid below shows **2**.

### Root cause
Same shape as Brief: the **stats** endpoint is unfiltered, the **list** endpoint enforces a per-user visibility predicate.

- `apps/board-api/src/services/board.service.ts:88-123` — `visibilityFilter(userId)` returns a SQL `OR` of:
  - `visibility = 'organization'`,
  - `created_by = userId`,
  - exists row in `board_collaborators`,
  - `visibility = 'project'` AND exists row in `project_members`.
- `listBoards` applies it on line 133:
  ```ts
  conditions.push(visibilityFilter(filters.userId));
  ```
- `getStats` (lines 452-467) does NOT:
  ```sql
  SELECT
    COUNT(*)::int AS total,
    ...
  FROM boards
  WHERE organization_id = ${orgId}
    AND archived_at IS NULL
  ```

So a user who can only see 2 boards is told there are 10 in total. The non-`archived_at` filter is correct, but the visibility filter is missing entirely. Worth noting: `getRecent` (line 469) DOES use `visibilityFilter`, so this is a one-line oversight in `getStats`.

The frontend wiring is fine:
- `apps/board/src/pages/board-list.tsx:11-17` — calls both `useBoardList` and `useBoardStats` and renders the stats card from the unfiltered stats.

### Recommended fix
Update `getStats` to take `userId` and add the visibility predicate, mirroring `getRecent`:

```ts
export async function getStats(userId: string, orgId: string) {
  const result: any[] = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '7 days')::int AS recent,
      (SELECT COUNT(*)::int FROM board_stars bs
        JOIN boards b2 ON bs.board_id = b2.id
        WHERE b2.organization_id = ${orgId}
          AND bs.user_id = ${userId}) AS starred
    FROM boards b
    WHERE b.organization_id = ${orgId}
      AND b.archived_at IS NULL
      AND (
        b.visibility = 'organization'
        OR b.created_by = ${userId}
        OR EXISTS (SELECT 1 FROM board_collaborators
                   WHERE board_id = b.id AND user_id = ${userId})
        OR (b.visibility = 'project' AND EXISTS (
              SELECT 1 FROM project_members
              WHERE project_id = b.project_id AND user_id = ${userId}))
      )
  `);
  ...
}
```

While here, also fix the **archived** count: the stats response currently does not include `archived` even though the frontend `BoardListPage` displays a "Archived" stat card (`board-list.tsx:41`) reading `stats.archived`. That value is currently undefined and shows as `0` accidentally. Add `COUNT(*) FILTER (WHERE archived_at IS NOT NULL)` to the same query (and pull the `archived_at IS NULL` predicate inside a `FILTER` instead of the WHERE clause). And the `starred` sub-query currently joins all stars in the org rather than the user's own stars — fix while you're there.

Then update the route handler that calls `getStats` to pass `request.user!.id`. Search for `boardService.getStats(` or `getStats(` in `apps/board-api/src/routes/`.

### Files
- `D:\Documents\GitHub\BigBlueBam\apps\board-api\src\services\board.service.ts` (lines 88-123 visibilityFilter, 129-196 listBoards, 452-467 getStats, 469-492 getRecent)
- `D:\Documents\GitHub\BigBlueBam\apps\board-api\src\routes\` (the route that wires `/boards/stats` — pass `userId`)
- `D:\Documents\GitHub\BigBlueBam\apps\board\src\pages\board-list.tsx` (no change needed — response shape stays the same)
- `D:\Documents\GitHub\BigBlueBam\apps\board\src\hooks\use-boards.ts`

---

## 4. Board — Template category tabs do not filter

### Symptom
The tabs (All, Retro, Brainstorm, Planning, Architecture, Strategy, General) on the Templates page all show the same template list.

### Root cause
The frontend correctly sends a `category` query param, but the API route ignores it.

- **Frontend (correct):** `apps/board/src/pages/template-browser.tsx:32-34`
  ```ts
  const [activeCategory, setActiveCategory] = useState<TemplateCategory | 'all'>('all');
  const { data, isLoading } = useTemplates(activeCategory === 'all' ? undefined : activeCategory);
  ```
- **Hook (correct):** `apps/board/src/hooks/use-templates.ts:43-52`
  ```ts
  api.get<TemplateListResponse>('/templates', { category: category ?? undefined })
  ```
- **Route (broken):** `apps/board-api/src/routes/template.routes.ts:46-54`
  ```ts
  fastify.get(
    '/templates',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const templates = await templateService.listTemplates(request.user!.org_id);
      return reply.send({ data: templates });
    },
  );
  ```
  No Zod schema for the query, no `category` extraction, no pass-through.
- **Service (broken):** `apps/board-api/src/services/template.service.ts:34-40`
  ```ts
  export async function listTemplates(orgId: string) {
    return await db
      .select()
      .from(boardTemplates)
      .where(or(isNull(boardTemplates.org_id), eq(boardTemplates.org_id, orgId)))
      .orderBy(asc(boardTemplates.sort_order), asc(boardTemplates.name));
  }
  ```
  Signature has no `category`. The `boardTemplates` table does have a `category` column (verified by `createTemplate` setting it on line 123), so the data is there to filter on.

### Recommended fix

1. Update the service:
   ```ts
   export async function listTemplates(orgId: string, category?: string) {
     const conditions = [or(isNull(boardTemplates.org_id), eq(boardTemplates.org_id, orgId))!];
     if (category) conditions.push(eq(boardTemplates.category, category));
     return await db
       .select()
       .from(boardTemplates)
       .where(and(...conditions))
       .orderBy(asc(boardTemplates.sort_order), asc(boardTemplates.name));
   }
   ```
2. Update the route to parse and pass it:
   ```ts
   const listQuerySchema = z.object({ category: z.string().max(100).optional() });
   ...
   async (request, reply) => {
     const { category } = listQuerySchema.parse(request.query);
     const templates = await templateService.listTemplates(request.user!.org_id, category);
     return reply.send({ data: templates });
   }
   ```
3. Sanity-check the seed data — confirm the seeded templates actually have varied `category` values matching the tab labels (`retro`, `brainstorm`, `planning`, `architecture`, `strategy`, `general`). If most seeded templates are NULL or `general`, the tabs will look almost-empty after the fix and may need a content pass.

### Files
- `D:\Documents\GitHub\BigBlueBam\apps\board-api\src\routes\template.routes.ts` (lines 45-54)
- `D:\Documents\GitHub\BigBlueBam\apps\board-api\src\services\template.service.ts` (lines 34-40)
- `D:\Documents\GitHub\BigBlueBam\apps\board\src\pages\template-browser.tsx` (no change required)
- `D:\Documents\GitHub\BigBlueBam\apps\board\src\hooks\use-templates.ts` (no change required)

---

## 5. MCP Server should not show in the Launchpad

### Symptom
The Launchpad grid (Cmd-K-style app switcher) shows an "MCP Server" tile that links to `/mcp/`. Users can't actually use MCP through a UI — it's a JSON-RPC / streamable HTTP transport server consumed by AI agents and the Anthropic SDK, not a human-facing app.

### Root cause
Hard-coded entry in the canonical Launchpad component shared by every frontend.

- `packages/ui/launchpad.tsx:41-57`, line 56:
  ```ts
  { id: 'mcp', name: 'MCP Server', description: 'AI Tools', icon: Bot, color: '#64748b', path: '/mcp/' },
  ```
- The `Bot` icon and `path: '/mcp/'` make it obvious this was added to advertise the MCP endpoint, but the path serves a JSON-RPC transport — clicking it returns a non-HTML response (or 405) and looks broken.

### Recommended fix
Delete line 56 of `packages/ui/launchpad.tsx`. Also remove the now-unused `Bot` import on line 20 (`import { ..., Bot, ... }`) — TypeScript will flag it under `noUnusedLocals` after the deletion. Every app that imports `@bigbluebam/ui/launchpad` picks up the change after a frontend rebuild (`docker compose build frontend && docker compose up -d --force-recreate frontend`).

If the team still wants discoverability of MCP for developers, the right home for it is a dev-docs link in the org settings page, not the Launchpad tile grid.

### Files
- `D:\Documents\GitHub\BigBlueBam\packages\ui\launchpad.tsx` (lines 20, 56)

---

## Cross-cutting observation

Bond / Brief / Board all share a "stats endpoint forgets the visibility filter that the list endpoint enforces" pattern. Worth a quick audit for the same bug shape across the other apps:

```
grep -rn "getStats\|getDocumentStats\|getBoardStats" apps/*/src/services/
```
…then check whether each one re-uses the same predicate as its sibling list query. Brief stats and Board stats both fail this audit; Bond's custom-field-definitions endpoint isn't a stats endpoint and isn't affected.
