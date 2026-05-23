# Banter UI Alignment Plan

Status: DRAFT — awaiting review.
Date: 2026-04-05.
Branch: `banter-ui`.

## 1. The problem

Banter's chrome (top bar + sidebar) was styled to resemble Slack. BBB
has its own established pattern. Today they diverge in ways that make
the two apps feel like different products when they're meant to be
siblings in the same suite:

- Cross-app navigation is placed differently
- Banter lacks the org switcher, search, notifications, and user menu
  that BBB's header provides
- The sidebars have similar ideas but different spacing, icons, and
  trailing sections
- Role-gated links (SuperUser, People, etc.) don't appear in Banter
  at all, so navigating between the two apps forces the user to
  mentally track "where am I and what can I do here"

The goal is **visual + functional consistency** between BBB and Banter
without losing what makes Banter good (the Channels/DMs tree + the
collapsible sections).

## 2. Side-by-side audit

### 2a. Top bar / cross-app navigation

| | **BBB** | **Banter** |
|---|---|---|
| Placement of cross-app nav | Inline in the main app header (left side, small pills) | Separate full-width dark bar above everything (h-10) |
| Alpha warning | (none) | Yellow banner row below the cross-app bar |
| Total chrome height above content | ~56px (just the header) | ~90px (cross-app bar + alpha banner + app header is implicit) |

### 2b. App header

| | **BBB** | **Banter** |
|---|---|---|
| Dedicated top header in the app area? | Yes — h-14, white/zinc-900 bg, border bottom | No — each page renders its own local header |
| Breadcrumbs | Yes | No |
| OrgSwitcher chip | Yes (shows current org + role, dropdown on hover) | **Missing entirely** |
| Search box | Yes (input with icon, header-right) | No (sidebar button) |
| Notifications bell | Yes (with unread badge + dropdown) | **Missing entirely** |
| User avatar menu | Yes (dropdown with profile/people/settings/logout) | Just a tiny gear icon next to avatar in the sidebar bottom |

### 2c. Sidebar

| | **BBB** | **Banter** |
|---|---|---|
| Width | 240px (`w-60`) | 260px |
| Logo / brand | Colored "B" square + "BigBlueBam" wordmark in sidebar top | "Banter" text only, no logo mark |
| Nav buttons `py` | `py-2` | `py-1.5` |
| Nav buttons icon gap | `gap-2` | `gap-2.5` |
| Quick actions | Dashboard, My Work | Search, Bookmarks, Browse channels |
| Main list | Projects (flat) | Channels + DMs (both collapsible with chevrons) |
| Role-gated entries | SuperUser, All users, People (bottom section) | **None** |
| Settings affordance | Full-width button row at sidebar bottom | Tiny gear icon next to the user avatar |
| User info at bottom | Not in sidebar (user is in header avatar menu) | Avatar + name + presence + gear |

### 2d. Notable small differences

- BBB sidebar colors use the same `bg-sidebar`/`bg-sidebar-hover`/
  `bg-sidebar-active` tokens as Banter — good.
- BBB uses a `custom-scrollbar` utility — Banter uses the same class.
- BBB's header supports full light/dark mode. Banter's sidebar is
  always dark; the content area swaps. The BBB header swaps too, so
  it reads as "app chrome = white in light mode, sidebar = dark."

## 3. Recommendations

### 3a. Unify the top bar

**Proposal:** remove Banter's separate cross-app bar. Give Banter an
app header styled like BBB's (h-14, white/zinc-900, border-bottom),
with the SAME cross-app pills Banter already uses, placed
left-aligned, matching the BBB pattern.

The Alpha banner becomes a thin bar (keep the yellow styling, shrink
the height to 6px padding) and sits below the header, like BBB's
no-owner banner pattern — appears conditionally, stacks under the
header.

Removing one row of chrome gives Banter back ~30px of vertical space.

### 3b. Give Banter an actual header

The new header should contain:

**Left cluster:**
- Cross-app pills (BBB / Banter / Helpdesk), Banter marked as
  active — same component/styling as BBB
- Breadcrumbs — for Banter they show things like "Channels / #general"
  or "DMs / Casey O'Connor"

**Right cluster:**
- **OrgSwitcher** — the exact same component BBB uses. Essential —
  a user on Banter should always see which org's channels they're
  looking at, and a SuperUser switching context has the same reliable
  affordance in both apps.
- Search (but see §3e)
- Notifications bell (mirror of BBB's — drives off `useUnreadCounts`
  or a future unified notifications queue)
- User avatar with DropdownMenu (Profile, People/Settings link,
  logout) — exact same styling as BBB's

### 3c. Sidebar alignment

Keep the Banter-specific content (Channels tree, DMs tree) but
normalize the shell:

- **Width**: 240px (`w-60`) to match BBB
- **Logo**: add a Banter logo mark — a colored square + "Banter"
  wordmark, matching BBB's "B" square + "BigBlueBam" wordmark pattern
  (same dimensions, same font size). Different color (e.g. teal or
  indigo) to distinguish, same shape.
- **Spacing**: normalize to BBB's `py-2` + `gap-2` on nav buttons;
  swap the smaller `py-1.5` / `gap-2.5` from Banter.
- **Role-gated entries at the bottom** — mirror BBB's pattern:
  - SuperUser (when applicable)
  - All users (SU only) — but maybe hide in Banter since it's about
    SU scope to BBB
  - People (admin+)
  - Settings (always)
- **Remove the bottom user-info panel** — user info moves to the
  header avatar menu like BBB. One place to find "who am I."

### 3d. What Banter-specific affordances to keep in the sidebar

- Channels collapsible section with inline create
- DMs collapsible section with start-DM member list
- Quick actions: Bookmarks, Browse channels (move Search to the
  header)
- The chevron-based collapse/expand behavior

### 3e. Search location

Two options:
1. **Full parity**: move Search to the header input, like BBB. Ctrl+K
   or `/` opens it. Banter search today is a sidebar button that
   navigates to a dedicated page — fine, the input in the header can
   navigate there too.
2. **Keep sidebar button**: acknowledge that chat search is heavier
   than task search (needs date/author/channel filters) and lives
   better as a full page.

I'd lean toward **Option 1** with a button that opens a modal
overlay, matching BBB's command palette pattern. Consistent entry
point = less learning.

### 3f. Notifications bell

BBB's header has a notifications bell that pulls from
`GET /me/notifications`. Banter doesn't expose anything in the
header today — unread messages are surfaced by the DM/channel rows
with bold styling + count badges.

Proposal: Banter's header notifications bell surfaces `unread` data
from `useUnreadCounts` as a dropdown list. Clicking an item
navigates to the channel/DM. Count badge on the bell icon shows
total unread + mentions, same as BBB's.

## 4. Proposed execution order

Grouped so each step can land + be reviewed independently:

1. **Add OrgSwitcher to Banter** (small, immediate value)
   - Extract the existing `OrgSwitcher` into a shared location (or
     duplicate minimally into Banter)
   - Wire it into the temporary top bar first, then move to the new
     header in step 3
2. **Normalize sidebar shell** — width, spacing, logo, remove bottom
   user-info panel, add role-gated entries
3. **Add the app header to Banter** — collapse the cross-app bar into
   the header; alpha warning becomes a thin conditional strip; add
   breadcrumbs, search, notifications, user avatar menu
4. **Move Search** to the header input
5. **Wire notifications bell** to `useUnreadCounts`
6. **Polish pass** — typography, hover states, dark-mode parity

## 5. Open questions

- **Banter logo mark** — color choice (teal? indigo? the brand system
  doesn't have a Banter mark today). Could also use a chat-bubble
  icon inside a colored square. ANSWER: I like the chat-bubble icon inside a colored square idea.
- **OrgSwitcher in SPAs that don't use BBB sessions** — Banter + BBB
  currently share the session cookie, so the switch works across
  apps. If this is ever decoupled (separate auth namespaces), need a
  different approach. ANSWER: Cross that bridge when we come to it. For now I see no reason to change it.
- **Notifications unification** — should Banter and BBB share a
  single notifications source, or do each app keep their own and the
  header bell just queries whichever app's API is current? Probably
  keep separate for now (simpler, matches the per-app architecture). ANSWER: I'd really like unified notifications.
- **"Alpha" banner** — do we keep it? Maybe reword to a small pill
  next to the Banter wordmark in the header (`Banter · alpha`) so it
  doesn't eat a whole row. ANSWER: small pill next to banter wordmark.
- **Breadcrumbs for Banter** — useful at all given the sidebar
  already shows the active channel? Or skip and fill the space with
  a channel title/topic? ANSWER: I think it's useful for consistency.
- **Width**: Banter is 260px, BBB is 240px. Banter needs slightly
  more horizontal space for longer channel names + DM display names.
  Could either keep Banter at 260px (intentional variance) or squeeze
  to 240px with more aggressive truncation. Probably keep 260px. ANSWER: Let's keep it as 260px. The slight difference probably won't be jarring and if it is, we can address it then.

## 6. Non-goals

- Changing Banter's core interaction patterns (messaging, threads,
  channels, DMs). This is a chrome-only pass.
- Redesigning BBB's chrome. BBB is the reference point.
- Supporting a third layout mode.
