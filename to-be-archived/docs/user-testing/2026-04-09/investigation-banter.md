# Banter — Investigation findings (2026-04-09)

Source bugs: `docs/user-testing/2026-04-09/Issues-detected-during-user-testing.md`, "Banter > Channel list" section.

This is RESEARCH ONLY. No code has been changed.

---

## Channel data model — short answer to "are channels tied to groups or org?"

Channels are scoped to **the organization** (`banter_channels.org_id`, NOT NULL, FK → `organizations.id`, ON DELETE CASCADE). They may *optionally* belong to a `banter_channel_group` via the nullable `channel_group_id` FK — but groups are an org-internal grouping mechanism, not a scoping boundary. Membership is enforced through the separate `banter_channel_memberships` table (one row per (channel, user)).

Schema reference: `apps/banter-api/src/db/schema/channels.ts` lines 15-53.

```text
banter_channels
  id                uuid PK
  org_id            uuid NOT NULL → organizations(id)   ← scoping boundary
  name              varchar(80)
  slug              varchar(80)
  type              public | private | dm | group_dm
  channel_group_id  uuid NULL → banter_channel_groups(id)   ← optional grouping
  is_archived, is_default, ...

UNIQUE (org_id, slug)
INDEX  (org_id, type, is_archived)
INDEX  (org_id, last_message_at)
```

Live DB confirms three orgs each have their own channel rows:

```text
              org_id                | count
------------------------------------+-------
57158e52-...-d9f3c4910f61 (Mage)    |     4
0fea63fe-...-601c337135a4 (BBC)     |     6
3ddf7c51-...-d33cd1cac8de           |     2
```

So the data model is correct: **channels are per-org, with optional intra-org grouping**. The bugs below are all in how that scoping is honored at the API and UI layers, not in the schema.

---

## Issue 1 — three-dots menu flashes and disappears

### Root cause — confirmed
Not an event-propagation issue. The menu disappears because its **mount is gated on a hover-tracking state in the parent wrapper**, and Radix's `DropdownMenu.Content` is rendered into a Portal *outside* the wrapper div.

File: `apps/banter/src/components/sidebar/banter-sidebar.tsx`

Relevant code, `ChannelItem` component:

- L382-386: wrapper `<div className="relative group" onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>{setHovered(false); setConfirmDelete(false);}}>`
- L413: `{hovered && ( ... <DropdownMenu.Root ... /> ... )}` — the *entire* `DropdownMenu.Root`, including the `Trigger` and the portaled `Content`, is conditionally rendered based on `hovered`.
- L417-422: the `MoreHorizontal` trigger button does call `e.stopPropagation()`, which is correct — clicks are not bubbling up to the channel-row button. So that hypothesis is wrong.
- L424-474: `DropdownMenu.Portal` renders `Content` at the document root, meaning the popup is **not** a DOM child of the wrapper div.

What actually happens:

1. User hovers a channel row → `hovered = true` → trigger renders.
2. User clicks the trigger → Radix opens the dropdown content in a Portal.
3. The Content appears with `sideOffset={4}` and `align="start"`, i.e. 4px below the trigger and shifted left, **outside the wrapper's bounding box**.
4. As soon as the cursor moves toward the menu (or even drifts a few px after clicking), it leaves the wrapper div's hit region.
5. `onMouseLeave` fires on the wrapper → `setHovered(false)` → React unmounts the conditional block → `DropdownMenu.Root` unmounts → menu vanishes mid-frame. That's the "flash".

Even without mouse motion the same fault appears whenever the trigger sits at the row edge: opening the menu shifts focus and the synthesized mouse events from Radix can land just outside the wrapper.

### Recommended fix
Decouple the dropdown's mount from `hovered`. Two viable approaches:

- **Preferred:** always render `DropdownMenu.Root` and instead toggle the *trigger button's* visibility (opacity / `group-hover:opacity-100`) based on hover. The Root stays mounted so its open state is owned by Radix, not by parent React state. Use Radix's `open`/`onOpenChange` if you want to hide the trigger only when both `!hovered && !open`.
- Alternate: lift the dropdown into a controlled state and keep it mounted while `open === true` *or* `hovered === true`. Track `[hovered, open]` and unmount only when both are false.

Tailwind already classifies the wrapper as `group`, so the opacity-based pattern is a one-liner on the trigger button: `className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 ..."`. No state needed at all.

Note: while fixing this, also drop the `setConfirmDelete(false)` reset from `onMouseLeave` — it should reset on dropdown close (`onOpenChange`) instead, which is already wired at L415.

---

## Issue 2 — channel list does not change when active org switches

### Root cause — confirmed (three independent contributing bugs)

This issue has **three layered defects**, any one of which alone would cause the symptom. All three are present.

#### 2a. The Banter API list query never filters by org

File: `apps/banter-api/src/routes/channel.routes.ts` lines 146-162

```ts
const rows = await db
  .select({ channel: banterChannels, membership: banterChannelMemberships })
  .from(banterChannelMemberships)
  .innerJoin(banterChannels, eq(banterChannelMemberships.channel_id, banterChannels.id))
  .where(
    and(
      eq(banterChannelMemberships.user_id, user.id),
      eq(banterChannels.is_archived, false),
    ),
  )
  .orderBy(desc(banterChannels.last_message_at));
```

There is **no `eq(banterChannels.org_id, user.org_id)` predicate**. The list returns every channel the user holds a membership in across **every** organization. For a multi-org user this is both a UX bug *and* a tenant-isolation leak — channel rows from other orgs are returned over the wire.

(Other handlers in the same file *do* scope by `user.org_id` correctly — e.g. `/channels/browse` at L416, `/channels/:id` at L437-439, the auto-#general bootstrap at L80-145, the create handler at L337-350. The list handler is the one that was missed.)

#### 2b. The Banter API auth plugin ignores `sessions.active_org_id`

File: `apps/banter-api/src/plugins/auth.ts`

- L74-128: `resolveOrgContext` honors `X-Org-Id` header, then `is_default` membership, then first membership by `joined_at`. It **never reads `sessions.active_org_id`**.
- L188-216: the session-cookie path joins `sessions` ⨝ `users` and selects only `users.*` — it does not select `sessions.active_org_id`.
- L54-68 (`bbb-refs.ts`): the Banter Drizzle schema for `sessions` doesn't even declare an `active_org_id` column, although the live DB has it (verified via `\d sessions`):

  ```text
  active_org_id | uuid |  |  |
  Indexes: sessions_active_org_id_idx btree (active_org_id)
  Foreign-key: REFERENCES organizations(id) ON DELETE SET NULL
  ```

Compare with Bam's auth plugin (`apps/api/src/plugins/auth.ts` L202-232) which reads `row.session.active_org_id`, looks up the matching membership, and pins `finalOrgId` to it. Banter has no equivalent.

Live verification: SuperUser eddie's active session has `sessions.active_org_id = 57158e52... (Mage Inc)`. He has memberships in Big Blue Ceiling (default) and Mage Inc. Calling Banter directly with his session cookie:

```bash
curl -b "session=$EDDIE_SESSION" http://localhost/banter/api/v1/channels
# → returns channels with org_id = 0fea63fe... (Big Blue Ceiling, his default), NOT Mage Inc
```

Even adding `-H "X-Org-Id: 0fea63fe-..."` returns the same set, because — per 2a — the list handler doesn't actually filter by org at all.

#### 2c. The Banter frontend never sends `X-Org-Id`

File: `apps/banter/src/lib/api.ts`

The `ApiClient.request` builder (L21-49) sets `Content-Type` only and no other headers. There is no equivalent of Bam's per-request `X-Org-Id` injection. The frontend stores the active-org id in `auth.store` (`user.active_org_id` from the `/b3/api/auth/me` payload) but never forwards it on Banter API calls.

`OrgSwitcher` at `apps/banter/src/components/layout/org-switcher.tsx` L52-61 does call `bbbPost('/auth/switch-org', ...)` against Bam (which rotates the session cookie and writes `sessions.active_org_id`), then `window.location.href = '/banter/'`. So the cookie *is* being updated correctly — but Banter's auth plugin (2b) never reads that column, and the channels handler (2a) wouldn't filter by it anyway.

### Recommended fix (apply all three)

1. **Backend list query (2a):** add `eq(banterChannels.org_id, user.org_id)` to the `where(...)` clause at `channel.routes.ts:156-161`. Audit the rest of the route file for any other handler that joins through `banterChannelMemberships` without an explicit `org_id` predicate — at minimum, the unread-counts subquery is safe because it scopes via `channel_id`, but worth a once-over.

2. **Backend session resolution (2b):** mirror Bam's pattern in `apps/banter-api/src/plugins/auth.ts`:
   - Add `active_org_id: uuid('active_org_id')` to the `sessions` Drizzle table in `apps/banter-api/src/db/schema/bbb-refs.ts` (no migration needed, the column already exists in the DB).
   - In the session-cookie branch of `authPlugin`, select `sessions.active_org_id` and pass it into `buildAuthUser` as a fourth argument.
   - Inside `resolveOrgContext`, prefer `sessionActiveOrgId` over the `is_default` fallback (still gating on the user actually being a member of that org). Keep `X-Org-Id` as the highest-precedence override so SuperUser/test paths still work.
   - Also consider mirroring Bam's SuperUser cross-org override logic (`is_superuser_viewing` flag) so SU-impersonate-org behaves consistently across apps.

3. **Frontend org header (2c) — defense in depth:** in `apps/banter/src/lib/api.ts`, inject `X-Org-Id: <user.active_org_id>` on every request when the auth store has a user. This makes the frontend resilient to (a) Banter API instances that haven't picked up the 2b fix yet and (b) the small race window between switching orgs in another tab and the session cookie's content being read on the next request. Also key the React Query cache by active org id (`['channels', activeOrgId]` in `use-channels.ts`) so a tab that's been open across org switches doesn't show stale data.

After 2a + 2b are in, the existing auto-`#general` bootstrap at `channel.routes.ts` L77-145 will automatically materialize a `#general` channel and add Eddie as owner the first time he opens Banter while `active_org_id = Mage Inc`, which is the expected first-run behavior in a new org.

---

## Issue 3 — "Are channels tied to groups or the org?"

Answered above in the **Channel data model** section. Summary:

- **Org is the scoping boundary.** `banter_channels.org_id` is NOT NULL, every list/read/write handler should (and almost all do) filter on it.
- **Channel groups are an optional in-org folder.** `channel_group_id` is nullable; deleting a group sets the FK to NULL, it does not cascade-delete the channel.
- **Membership is per-channel via `banter_channel_memberships`,** independent of channel group. Public channels can be browsed at `/v1/channels/browse` (which IS org-scoped, see L411-421) and joined explicitly; private channels require an invite.

The user's mental model ("are channels tied to groups?") almost certainly comes from observing that the channel list doesn't change with the org switch — they're trying to figure out which dimension *is* doing the scoping. The fix to Issue 2 will eliminate that confusion.

---

## Files referenced

Frontend:
- `D:\Documents\GitHub\BigBlueBam\apps\banter\src\components\sidebar\banter-sidebar.tsx` (Issue 1: ChannelItem L315-480, hover gating L382-386 + L413)
- `D:\Documents\GitHub\BigBlueBam\apps\banter\src\lib\api.ts` (Issue 2c: no X-Org-Id header)
- `D:\Documents\GitHub\BigBlueBam\apps\banter\src\hooks\use-channels.ts` (Issue 2c: query key not org-keyed, L52-57)
- `D:\Documents\GitHub\BigBlueBam\apps\banter\src\components\layout\org-switcher.tsx` (does call /auth/switch-org and reload — that part works)

Backend:
- `D:\Documents\GitHub\BigBlueBam\apps\banter-api\src\routes\channel.routes.ts` (Issue 2a: list handler missing org filter, L146-162)
- `D:\Documents\GitHub\BigBlueBam\apps\banter-api\src\plugins\auth.ts` (Issue 2b: ignores sessions.active_org_id, L68-128 + L188-216)
- `D:\Documents\GitHub\BigBlueBam\apps\banter-api\src\db\schema\bbb-refs.ts` (Issue 2b: sessions table missing active_org_id column, L54-68)
- `D:\Documents\GitHub\BigBlueBam\apps\banter-api\src\db\schema\channels.ts` (Issue 3: confirms org scoping, L15-53)

Reference (correct implementation):
- `D:\Documents\GitHub\BigBlueBam\apps\api\src\plugins\auth.ts` (Bam's pattern for `sessions.active_org_id`, L202-248)
- `D:\Documents\GitHub\BigBlueBam\apps\api\src\routes\auth.routes.ts` (`/auth/switch-org` handler, L304+, sets `sessions.active_org_id`)
