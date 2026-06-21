# Beacon — Investigation (2026-04-09 user testing)

Status: research only, no fixes applied.

---

## Issue 1 — Search box appears then turns black

### What the user reported

> "Selecting search causes the search box to quickly appear and turn black.
> You can refresh to briefly see it again, but something is making it
> disappear right away."

### Reproduction attempts

I could **not** reproduce the bug with Playwright using either the
seeded e2e admin user **or** `test@bigbluebam.test` against the
running container. Tested all of:

1. Direct navigation to `/beacon/search` (auth pre-loaded).
2. Navigate to `/beacon/`, click sidebar `Search`.
3. Navigate to `/beacon/`, click `Search` action card on home.
4. Type a query into the search input.

All scenarios rendered the search page correctly with the empty-state
prompt or the "No Beacons match…" copy. Zero `pageerror` events, zero
console errors, zero failed requests, root DOM length stayed at ~14.4 KB
throughout.

### Root cause (history) — already partially fixed

This bug had a previous fix on 2026-04-08:

```
0d1d9ce  fix: Beacon search blank screen — stop default status filter
         from triggering empty search
```

Original cause (per that commit): `search.store.ts` defaults
`statusFilters: ['Active']`. Both `useBeaconSearch` and the page's local
`hasActiveQuery` flag previously counted `status?.length > 0` as an
"active filter", so the page mounted, fired `POST /search` with an empty
query, and rendered the result panel from a response that was missing
fields the `ResultList` props expected. The fix removed the `status`
check from `hasFilters` in three places and added an `isError` branch
to `beacon-search.tsx`.

Verified the fix is **live in the running bundle**:

```
$ curl -s http://localhost/beacon/assets/index-CnnCrB_J.js \
    | grep -c "Search failed:"
1
```

The frontend container was rebuilt at `2026-04-09 17:17 PDT` (after the
0d1d9ce commit), and the user-testing notes were saved at `21:29 PDT`
the same day, so the user **was** testing the fixed bundle and still
saw the bug. That points to a residual cause the previous patch didn't
address.

### Likely residual cause — missing React error boundary

The Beacon SPA root has **no error boundary**:

```
apps/beacon/src/main.tsx:20-26
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
```

Under React 19, an unhandled render-time exception with no boundary
**unmounts the entire root**. The DOM `<div id="root">` becomes empty,
and the `body { background: ... }` (or the parent `bg-zinc-950` from
the previous frame, which is gone too) shows through. To a user this
reads as: "the page flashes briefly, then turns black." Refreshing
re-runs the initial render so they see it for another instant.

So even though I cannot pinpoint *which* render path throws for the
user's specific data, the symptom they describe — flash, then black,
preserved across refresh — is exactly what a missing error boundary
produces. Without a boundary we have no telemetry, and the user has
no fallback UI.

### Other suspect render paths (worth defending against)

While reading the search code I noticed these fragile spots that
could plausibly throw under user data the e2e seeds don't cover:

1. `apps/beacon/src/components/search/result-card.tsx:71` —
   `onNavigate(`/${result.slug}`)`. If the API ever returns a result
   with `slug == null` (the type marks it `string`, but the
   `SearchResultLinkedBeacon` interface has it optional), the card
   still renders fine — the click handler is the only consumer.
   Not a render throw, but it would 404 silently.

2. `apps/beacon/src/components/search/query-builder.tsx:299` —
   `useSearchStore()` is called with **no selector**, returning the
   whole store object. Combined with `setDebouncedRequest(toSearchRequest(0))`
   inside `useEffect` that lists `toSearchRequest` as a dep, this could
   in theory loop on mount because `toSearchRequest` is a fresh
   reference every render. In practice zustand keeps method refs stable
   across un-mutated renders, so it doesn't loop, but it's brittle.

3. `apps/beacon/src/pages/beacon-search.tsx:14` — the page uses
   `const store = useSearchStore()` (no selector) and then mounts
   `<QueryBuilder />` which does the same. With `<StrictMode>` doubling
   effects, the URL hydration `store.fromSerializable(urlState)` can
   fire twice on first mount (the `hydratedRef` guard prevents repeat
   inside one StrictMode mount but a remount path could re-enter it).
   If the URL ever carries a malformed `?q=` value, `fromBase64Url`
   throws inside a try/catch, but `JSON.parse` on a half-valid string
   could push state with `undefined` arrays. The store setters then
   pass those to `pushSearchStateToUrl`, which calls `state.tags.join(',')`
   on `undefined` → `TypeError`.

### Recommended fix

**Required (root cause):**

Add a React error boundary at the SPA root in
`apps/beacon/src/main.tsx`. Render the boundary's fallback inside the
existing `<BeaconLayout>` so the user keeps the sidebar/header even
when a page crashes, and log the error to console + (optionally) the
existing notification system. Pattern: a small `class ErrorBoundary
extends Component` plus a `<div className="p-8 text-red-600">Something
went wrong rendering this page. <button onClick={reset}>Reload</button></div>`
fallback. ~30 lines.

**Defensive (prevent the throw in the first place):**

1. In `query-serializer.ts` `deserializeFromUrl`, after parsing, coerce
   every array field with `Array.isArray(parsed.tags) ? parsed.tags : []`
   instead of `parsed.tags ?? DEFAULTS.tags`.
2. In `result-card.tsx`, fall back to `result.beacon_id` if `result.slug`
   is missing: `onNavigate(\`/${result.slug ?? result.beacon_id}\`)`.
3. In `query-builder.tsx`, switch `useSearchStore()` calls to selectors
   for the specific fields used (one selector per field, or a single
   `useShallow` from `zustand/shallow`). Same for
   `beacon-search.tsx:14`.

**Estimated effort:** 1-2 hours total. The error boundary alone is the
load-bearing fix; defensive items take ~15 min each.

---

## Issue 2 — Graph view nodes too clustered

### What the user reported

> "I feel like the 'repulse' feature that pushes the nodes farther
> away from each other is still not strong enough. In most Graph views
> the nodes are still mostly on top of one another. Can we rethink
> this view — maybe make it a 3D view that the user can navigate
> through spatially?"

### Current implementation

The graph is **a hand-rolled 2D force-directed simulation in plain
TypeScript**, rendered as SVG. There is no third-party graph library.

- Engine: `apps/beacon/src/lib/force-layout.ts` (~185 lines, pure function)
- Renderer: `apps/beacon/src/components/graph/graph-canvas.tsx` (SVG `<g>`/`<circle>`)
- Forces per iteration:
  1. Coulomb-like all-pairs repulsion: `force = (repulsion * alpha) / dist²`
  2. Hooke's-law spring attraction along edges:
     `force = attraction * (dist - idealLength) * alpha`
  3. Centering pull toward (0,0): `v -= pos * centering * alpha`
  4. Velocity capped at `maxSpeed = 50`, damped by `0.85` per tick
- Cooling: `alpha = startAlpha * (1 - iter / iterations)`, early-exit
  when `alpha < 0.001`.

### Current force parameters (graph-canvas.tsx:140-145)

```ts
runForceLayout(layoutNodes, layoutEdges, {
  iterations: Math.min(150, 50 + nodes.length * 3),
  repulsion:  2500,   // engine default is 800 — already triple
  attraction: 0.025,  // engine default is 0.04 — softer than default
  idealLength: 180,   // engine default is 120 — longer springs
});
```

Centering / damping / maxSpeed all use the engine defaults
(`0.01`, `0.85`, `50`).

So the call site already cranks repulsion up 3.1× the engine default
and stretches the springs by 1.5×. Despite that, the user reports nodes
still pile on top of each other. That makes sense for these reasons:

1. **The repulsion force decays as 1/dist².** When nodes start *very*
   close (initial layout puts them on a circle of radius
   `0.3 * min(width, height) ≈ 180px` regardless of count), the
   repulsion is huge and they explode apart, but `maxSpeed = 50` caps
   how fast they can separate. Combined with `damping = 0.85` and
   `alpha` cooling linearly to zero over ~150 iterations, the system
   freezes before fully relaxing when there are more than ~30 nodes.

2. **`effectiveDist = max(dist, minDist * 0.5)`** in `force-layout.ts:101`
   actually *weakens* the repulsion at close range — at distances below
   `(rA + rB) / 2` the divisor is held at the minimum so the force
   plateaus instead of going to infinity. That's the opposite of what
   you want for collision avoidance. A real collision-avoidance term
   (e.g., d3-force's `forceCollide`) needs an *inverse* shape that
   blows up as distance shrinks.

3. **No collision force at all.** The code has nothing equivalent to
   d3's `forceCollide(radius)`. With node radii ranging 22-60 px and
   an `idealLength` of 180 px, two large hubs connected by an edge
   are already at "rest" while still visually overlapping.

4. **The centering force is applied even on the focal node's siblings**
   regardless of how far out they want to be. It pulls them back toward
   the origin every tick. With `centering = 0.01 * alpha`, the early
   iterations dominate node motion before repulsion can spread things
   out.

5. **Iteration cap is too low for hub views.** `Math.min(150, 50 + 3n)`
   maxes out at 150 even for a 100-node hub. d3-force's default is
   300 ticks for static layouts, and most production graphs need more.

### Recommended fix — quick path (2D, retain SVG renderer)

Keep the SVG-renderer + custom physics, but rewrite the force loop:

1. **Add a collision force.** New pass each iteration that pushes any
   two nodes whose center-distance is less than `(rA + rB + padding)`
   apart by half the overlap, no falloff. Padding ~12 px gives nodes
   visible breathing room. This is the single highest-impact change.
2. **Remove the `effectiveDist` plateau** in repulsion and instead clamp
   the force itself: `force = min(repulsionMax, repulsion * alpha / dist²)`.
   Lets close-range repulsion still bite, without producing NaN-tier
   forces.
3. **Raise `maxSpeed`** to ~150 and **lower damping** to ~0.7 so the
   system actually relaxes within the iteration budget.
4. **Bump iterations** to `min(400, 100 + 4n)` and lower the early-exit
   threshold to `alpha < 0.0005`.
5. **Drop centering** when there's a focal node (it's already pinned
   to center, so the centering term just fights repulsion). Keep it
   only on the hub-graph view.
6. **Better initial layout.** Replace the 0.3*min-dim circle with
   `r = max(180, sqrt(nodes.length) * 60)` so a 50-node graph starts
   spread over ~3000 px instead of ~180 px.

These six changes are all in `force-layout.ts` and the call site in
`graph-canvas.tsx` — about 80-120 lines of code, no new dependencies,
no DOM/renderer changes.

**Estimated effort: low (3-4 hours including a quick visual sanity
check).** This will most likely solve the user's complaint without
the cost of a 3D rewrite, and is worth doing first regardless.

### Recommended fix — 3D rethink (the user's suggestion)

#### What it would take

The Beacon `package.json` has **no 3D dependencies today**. To go 3D:

| Approach | Adds | Bundle cost (gzipped) | Notes |
|---|---|---|---|
| `3d-force-graph` (vasturiano) | three.js + 3d-force-graph + d3-force-3d | ~250 KB | Highest level, drop-in. Uses three.js under the hood, gives camera controls, node/edge picking, force tuning, labels via CSS2DRenderer. About 30-50 lines of integration code. |
| `react-force-graph-3d` | three.js + 3d-force-graph + React wrapper | ~260 KB | Same engine as above with a React component API. Slightly nicer ergonomics in this codebase. |
| Hand-rolled `@react-three/fiber` + `@react-three/drei` + `d3-force-3d` | three.js + R3F + drei + d3-force-3d | ~350 KB | Maximum flexibility (custom shaders, post-processing, VR). Much more code (~500-800 lines) and a bigger learning curve. |

The recommended option if we go 3D is **`react-force-graph-3d`**: it's
the lowest-effort path, the engine is well-tested, the API matches
our existing `nodes`/`edges`/`onNodeClick` shape almost exactly, and
it includes camera controls (orbit/pan/zoom), node picking, and edge
labeling out of the box.

#### Integration sketch

1. `pnpm --filter @bigbluebam/beacon add react-force-graph-3d three`
2. Replace the body of `graph-canvas.tsx` with a `<ForceGraph3D>` that
   maps existing `GraphNode` → `{ id, name: title, val: radius, color: nodeRingColor() }`
   and `GraphEdge` → `{ source, target, color, type }`.
3. Replace SVG node-popover positioning with three.js raycasting →
   screen coords (the lib provides `nodeAtScreen` / `screen2GraphCoords`
   helpers).
4. Recreate the at-risk pulse animation as a `THREE.PointsMaterial` or
   a custom node `nodeThreeObject` callback.
5. Decide what happens to the existing dim/filter overlay — easiest is
   `nodeColor: (n) => isDimmed(n) ? '#444' : nodeRingColor(n)`.
6. Verify the existing pan/zoom-replacement controls (mouse wheel +
   left-drag) still feel right — `ForceGraph3D` defaults are good but
   different from the current SVG handlers.

#### Trade-offs

**Pros**
- Genuinely solves the clustering complaint: 3D space has dramatically
  more room than a 900×600 SVG viewport, and the included `d3-force-3d`
  is mature.
- Camera navigation is intuitive for users who think spatially.
- Built-in features we'd otherwise have to write (labels, picking,
  link directionality arrows, particle traffic, etc.).

**Cons**
- ~250 KB gzipped added to the Beacon bundle (currently ~280 KB total).
  Roughly doubles the load time on cold cache.
- Loses the SVG accessibility story. Three.js renders to a `<canvas>`,
  so screen readers see nothing.
- Touch / mobile is awkward — orbit controls on a phone aren't great.
- Print/export becomes harder (today's SVG can be rasterized or saved
  as a PDF; canvas screenshots are bitmap-only).
- Existing custom rendering features (at-risk pulse, freshness rings,
  status fill) all need to be re-implemented with three.js primitives
  or R3F components.
- Visual style of the rest of Beacon is flat 2D — a 3D graph view will
  feel disconnected unless we lean into a "spatial mode" framing.

#### Estimated effort

- **Medium** for the basic swap-in of `react-force-graph-3d` with
  parity on nodes/edges/click-to-expand: ~1-2 days for one engineer.
- **Medium-high** if we want full feature parity with the current 2D
  view (popover, filter dimming, at-risk pulse, dark-mode toggle,
  legend, breadcrumb navigation, etc.): ~3-5 days.
- **High** if we go the `@react-three/fiber` route for custom
  shaders/post-FX: ~1-2 weeks.

### Recommendation

**Do the quick 2D fix first** (low effort, strong impact, no bundle
cost, no a11y regression). If after that the user still feels nodes
are too cramped on hub-graph views with hundreds of beacons, *then*
add `react-force-graph-3d` as a **toggleable mode**: keep the SVG 2D
renderer as the default and add a "3D view" button in the graph
toolbar that swaps in the three.js canvas. That avoids the bundle
hit on every page load (lazy-import the 3D module) and preserves the
existing accessible flow.

---

## Files relevant to these issues

- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\main.tsx` — needs error boundary
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\app.tsx` — route table
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\pages\beacon-search.tsx`
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\stores\search.store.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\components\search\query-builder.tsx`
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\components\search\result-list.tsx`
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\components\search\result-card.tsx`
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\lib\query-serializer.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\hooks\use-search.ts`
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\pages\graph-explorer.tsx`
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\components\graph\graph-canvas.tsx` — force call site
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\lib\force-layout.ts` — physics engine
- `D:\Documents\GitHub\BigBlueBam\apps\beacon\src\components\graph\knowledge-home.tsx` — hub graph view
