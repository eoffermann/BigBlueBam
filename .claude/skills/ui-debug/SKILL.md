---
name: ui-debug
description: Debug a UI feature by writing its expected-behavior user story, then walking the full stack top-down — UI control → handler → hook → API route → backend logic → data effect — and smoke-testing it live on the local dev stack with self-cleaning test data. Use when a UI element "does nothing", silently fails, or "looks wired but isn't", and before declaring ANY UI feature done. Nothing is "done" until the UI is proven to call real logic and that logic is proven to do what the story says.
---

# UI debug — walk the stack, prove every layer

You are debugging a UI feature end-to-end. You run in the MAIN conversation:
you ask the user the clarifying questions, you write the user story, you walk
the stack, and you run the live smoke test. The job is not to make the symptom
go away — it is to **prove**, layer by layer, that the control the user touches
reaches real logic and that the logic does what it is supposed to do.

Read `reference.md` in this skill's directory before starting — it has the
BigBlueBam request-path topology (SPA → api-client baseURL → nginx → Fastify
route → Drizzle → Postgres), the per-app base-URL table (the inconsistent
`/v1` prefixing is the #1 source of silent 404s), and the local smoke-test
cookbook (auth, data setup/teardown, the rebuild/restart gotcha).

## The premise: "looks wired" ≠ "works"

Every boundary between layers is a place a contract silently drifts, and TypeScript
+ a passing build will NOT catch any of them:

- A button with **no `onClick`** at all (dead placeholder).
- A handler that calls a hook that **PATCHes a URL that doesn't exist** → 404,
  swallowed, nothing happens.
- A page that **GETs the wrong path** and renders an empty list forever.
- A response whose **field names don't match** what the component reads
  (`loss_reasons` vs `top_loss_reasons`) → blank screen / undefined.
- A real request **aborted by a navigation** before it lands (`keepalive`).
- A route gated by a **permission preHandler** the real user fails → silent 403.

The cardinal sin is declaring a feature done because the control renders, the
types check, or the code "looks right." None of those exercise the wire. This
skill exists to make that impossible.

## Arguments

`/ui-debug <description of the broken or suspect behavior>`

Free text: which UI element, what the user does, what should happen, what
actually happens. If the description is thin, ask exactly: *what element, what
action, what is the expected result, and what do you observe instead* — then
proceed. You may be handed several related symptoms at once; debug each as its
own pass but share the setup.

## Phase 0 — Write the expected-behavior user story

Before touching code, write the contract the rest of the work measures against.
A concrete, end-to-end story — **not** "the button should work":

> As a **\<role\>**, when I **\<exact action on element Y\>**, then **\<the
> system does Z\>**, the change **persists** (survives reload), and I see
> **\<visible result\>**. *(Plus any cross-surface effect: badge updates, other
> tab refreshes, appears on page W.)*

Spell out the full chain of intended effects: optimistic UI, the server-side
persistence, what should be true after a hard refresh, and any second-order
surface (a list elsewhere, a counter, a realtime push). This list becomes your
assertion checklist in Phase 3. If the intended behavior is genuinely ambiguous,
ask the user once to confirm the story, then lock it.

## Phase 1 — Locate the control + verify Layer 1 (UI → logic)

1. Find the component and the **exact** control (button / menu item / form /
   input). Quote its JSX.
2. Verify it is actually connected:
   - Does it have a real `onClick` / `onSubmit` / `onSelect` / `onChange`?
   - Is the handler non-empty and does it reference a function/mutation/hook
     that exists (not `() => {}`, not a TODO, not a styling-only button)?
   - For Radix/menu items: is it `onSelect`/`onClick` and does it call through?
3. If the control is a **dead placeholder**, that is the (first) bug. Record it
   with `file:line`. Do not stop — keep walking so you find every break, not
   just the first.

## Phase 2 — Walk the action to the metal (Layer 2)

Trace every hop from the handler to the side effect, and **verify the contract
at each boundary**. This is desk-checking, but rigorous — you are confirming
that what the UI sends is exactly what the backend expects.

1. **handler → hook/function**: it exists, is imported, called with the right args.
2. **hook → api-client call**: resolve the *full request*:
   - method (GET/POST/PATCH/DELETE),
   - the path passed to the client,
   - the client's **baseURL** (READ `apps/<app>/src/lib/api.ts` — do not assume;
     see the table in `reference.md`, the `/v1` prefix is present in some apps and
     absent in others),
   - the request body shape.
3. **map to the backend route**: compute the wire path and the route path
   (`reference.md` §Resolving a call → route). Then **find a literal matching
   route**: `grep -rn "fastify.<method>(" apps/<svc>-api/src/routes` and confirm
   the method **and** path segment-for-segment. A near-miss
   (`/channels/:id/messages/:id` vs `/messages/:id`, `/me/bookmarks` vs
   `/bookmarks`) is the bug.
4. **route handler does the thing**: read the handler. Does it actually perform
   the intended effect (the DB insert/update/delete, the side effect)? Or is it a
   stub / wrong table / wrong column?
5. **permissions won't silently reject the real user**: check the `preHandler`s
   (`requireChannelAdmin`, `requireScope`, `requireCan(...)`). If the action is
   gated tighter than the UI implies, a normal user gets a silent 4xx — flag it.
6. **response shape matches what the UI reads**: compare the handler's returned
   field names against what the component destructures/renders. Field-name drift
   is a real bug even when the request succeeds.

Record every mismatch with `file:line` on both sides. If you find the break here,
you still must do Phase 3 — a desk-check is a hypothesis; the smoke test is proof.

## Phase 3 — Smoke test live on the local dev stack (Layer 3)

Prove it against running code. See `reference.md` §Smoke cookbook for the exact
commands. Discipline:

1. **Stack current**: ensure `docker compose` is up and the relevant service is
   built from *current* code. If you changed a service, rebuild + recreate it
   (and `docker compose restart frontend` after recreating an API — the nginx
   upstream-IP gotcha). NEVER `docker compose down -v`.
2. **Auth context**: establish a real authenticated session (login → cookie jar,
   or an API key, or the bigbluebam MCP server). Many flows also need an
   `X-Org-Id` header — see the cookbook.
3. **Create test data** needed to exercise the path (a channel, a message, a
   deal…). Prefer MCP tools or the app's own create endpoints. **Record every id
   you create** for teardown.
4. **Replay the EXACT request the UI makes** — same method, same resolved URL,
   same body — with the authenticated session. Not a convenient MCP shortcut down
   a different path: the point is to exercise the wire the UI actually uses.
5. **Assert the intended effect** from the story: read it back (the read
   endpoint the UI uses, or `psql`). Confirm persistence (re-fetch), the response
   shape, and any second-order surface. Test the **negative/edge** too where it
   matters (e.g. the permission-denied path).
6. **Clean up after yourself**: delete everything you created, in reverse order,
   and confirm it's gone. Leave the stack exactly as found. If cleanup partially
   fails, say so loudly with the leftover ids.

## Phase 4 — Verdict + Definition-of-Done gate

A feature debugged through this skill is **"done" only if BOTH hold**:

1. **UI → logic proven**: the control invokes the real logic (Phases 1–2: a live
   handler → a hook → a request that hits a route that exists with matching
   method/path/body).
2. **Logic verified**: the smoke test (Phase 3) shows the logic does what the
   story says — the effect happened, persisted, and the UI-consumed shape matches.

If either fails, the feature is **NOT done** — report precisely which layer broke,
with `file:line` and the exact request/response (or psql) evidence. If you fixed
it during the pass, **re-run the smoke test** and show the green result; a fix is
not proven by the edit, only by the re-run.

## Reporting

End with the repo-standard two blocks (see root `CLAUDE.md`):

1. **Summary** — the user story, the layer that broke (with evidence), the fix.
2. **How to see it in action** — exact clicks/URLs/commands the user runs to
   confirm, including the negative check. State plainly that the smoke test ran
   against the **local dev** stack and that test data was cleaned up.

Record any pre-existing-but-out-of-scope bugs you trip over as `TaskCreate`
entries (per the "pre-existing is not a dismissal" rule) — do not bury them.

## Hard rules

- **Local dev only** for the smoke test, never prod, unless the user explicitly
  says otherwise. Writes to a live board are real and not auto-reverted.
- **Always clean up** created test data; never leave the stack dirty.
- **Never declare done on typecheck / "looks wired" alone.** Layer-3 proof is
  mandatory. If you genuinely cannot smoke test (no auth, missing dependency),
  say so explicitly and mark the feature **unverified**, not done.
- **Never `docker compose down -v`** (it wipes the seeded test DB).
- Walk **all** the layers even after finding the first break — report every
  broken hop, not just the top one.
