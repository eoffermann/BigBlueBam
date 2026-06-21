# Banter help.md - Review

## Verdict: CHANGES REQUESTED

One-line rationale: The doc is accurate on the two highest-risk areas (voice
calls retired to Bureau / HTTP 410; Search page broken), but two code-backed
facts are wrong: the MCP tool count (says 54, code has 53) and the Bolt event
name (writes banter.message.matched instead of the canonical bare
message.matched on source banter).

Reviewed against:
- docs/apps/banter/help.md
- docs/.help-build/banter/dossier.md
- backend apps/banter-api/src (call.routes.ts, search.routes.ts, message.routes.ts,
  dm.routes.ts, file.routes.ts, admin.routes.ts)
- frontend apps/banter/src (search.tsx, message-compose.tsx, channel-settings.tsx,
  preferences.tsx, admin.tsx, message-item.tsx, banter-sidebar.tsx,
  thread-panel.tsx, use-keyboard-shortcuts.ts)
- MCP apps/mcp-server/src/tools/banter-tools.ts (+ banter-subscription-tools.ts)
- apps/bolt-api/src/services/event-catalog.ts,
  apps/worker/src/jobs/banter-pattern-match.job.ts

---

## What passed (high-confidence)

- Template completeness: all four required sections present and filled; "Working
  with AI agents" present; stories cover setup, core loop, collaboration,
  search/reporting, and two agent flows (schedule, pattern subscription).
- CRITICAL: voice/audio calls correctly presented as retired. call.routes.ts
  returns HTTP 410 from every write endpoint (start / join / leave / end /
  invite-agent / remove-agent / media-state / PATCH). Doc presents Banter calls
  as read-only history plus the Bureau docked box for live audio. Accurate.
- CRITICAL: Search page truthfully described as broken. search.tsx line 58 calls
  api.get('/search', ...); the only backend route is GET /v1/search/messages;
  lib/api.ts does not rewrite /search. Doc tells users not to rely on the Search
  page or header search and to use the API or an agent. Accurate.
- No em dashes in help.md (0 occurrences). UI strings in code that contain em
  dashes are correctly re-rendered with spaced hyphens when quoted.
- All four referenced screenshots exist:
  docs/apps/banter/screenshots/light/01-channels.png, 02-channel-view.png,
  03-threads.png, 04-dms.png (dark variants present too). NB: light 01 and 02 are
  byte-identical (94952 B), matching the dossier duplicate-capture note; both
  exist so the convention is satisfied, but a future screenshot refresh should
  distinguish them.
- Spot-checked labels all trace to code: "beta" pill + "Banter" wordmark; compose
  toolbar Bold/Italic/Code/Link/Attach file/Emoji and hint
  "Enter to send, Shift+Enter for newline"; 24-emoji palette (COMMON_EMOJIS has
  exactly 24); quick reactions thumbs up / heart / laughing / party / eyes /
  rocket; "Couldn't pin - channel admins only"; "This message is locked - nobody
  may edit it."; "(edited)"; Channel Settings + Danger Zone + "Yes, delete
  channel" + the delete-confirm sentence; Browse Channels / "No channels found";
  Bookmarks / "No bookmarks yet"; admin "Who can create channels"
  Everyone/Admins only/Organization owners only; preferences
  Profile/Theme(Light/Dark/System)/Notifications/Messaging + "Save Preferences";
  keyboard shortcuts Ctrl/Cmd+K, Ctrl/Cmd+Shift+M, Esc, ?, ArrowUp in empty
  compose. Login gate string matches.
- Known-bug caveats all trace to code: compose attach reads result.data.id but
  /files/upload returns url/key/filename/content_type/size_bytes (no id);
  channel-settings add-member posts {identifier} while API expects {user_ids:[]};
  preferences toggles do not all round-trip (backend schema differs, theme is
  localStorage bbam-theme). Viewer read-only and group DM 3-8 confirmed in code.

---

## Fix list (numbered)

1. MCP tool count is wrong: 54 -> 53.
   - File/section: help.md, "Working with AI agents" (line 285:
     "54 core Banter tools plus 3 subscription tools") and "Related" (line 559:
     "the 54 Banter tools plus the 3 subscription tools").
   - What is wrong: apps/mcp-server/src/tools/banter-tools.ts has exactly 53
     registerTool(...) call sites and 53 unique banter_* names. CLAUDE.md's own
     MCP breakdown also says "53 Banter". The dossier says 54; both it and the
     doc are off by one.
   - What it should be: "53 core Banter tools plus 3 subscription tools" (and the
     matching phrase in Related). Phrasing as "over 50" per the counts convention
     is also acceptable.

2. Bolt event name written with a source prefix: banter.message.matched ->
   message.matched (source banter).
   - File/section: help.md, several spots: "Working with AI agents" (line 289 and
     the event list on line 293), Story "Have an agent listen for a pattern and
     respond" (line 479), and "Related" Bolt bullet (line 558).
   - What is wrong: the worker publishes
     publishBoltEvent('message.matched', 'banter', ...)
     (apps/worker/src/jobs/banter-pattern-match.job.ts ~line 408-409) and the
     catalog registers source 'banter', event_type 'message.matched'. Per the
     project Bolt naming convention (bare name + explicit source; CLAUDE.md), the
     event is message.matched, not banter.message.matched. The doc writes every
     other Banter event bare and correct (message.posted, reaction.added, etc.);
     only the matched event carries the wrong banter. prefix.
   - What it should be: refer to the event as message.matched (on source banter),
     consistent with the other event names in the doc.

3. "Who can create channels" mapping understated (minor / polish).
   - File/section: help.md, "Admin: organization policy" note (line 247).
   - What is wrong: the doc says the server "stores only two distinct policies
     (members or admins)" and that "Admins only" and "Organization owners only"
     "may resolve to the same admin-level rule." In code the mismatch is sharper:
     the frontend sends 'everyone' | 'admins' | 'org_owners'
     (apps/banter/src/pages/admin.tsx), but the backend PATCH schema accepts only
     z.enum(['members','admins']) (apps/banter-api/src/routes/admin.routes.ts
     line 14). So 'everyone' is not the backend 'members', and 'org_owners' is
     not a valid backend value at all - two of the three options do not map
     cleanly and may be rejected or dropped on save.
   - What it should be: keep the caution but tighten the wording so it does not
     imply only the third option is affected. Optional; current text is hedged
     with "may" and is not strictly false, so this is polish, not a blocker.

---

## Accuracy findings (labels / claims that did not trace cleanly to code)

- Count "54 Banter tools" -> not in code; code has 53. (Fix 1.)
- banter.message.matched -> not the emitted or catalogued name; it is
  message.matched on source banter. (Fix 2.)
- "Who can create channels" three options all selectable into the backend ->
  backend accepts only members|admins; two of three UI values do not map.
  (Fix 3, understated in the doc.)

No other label or feature claim failed to trace. The voice-calls-retired and
Search-broken treatments are both correct and code-backed.

## Notes for the orchestrator
- Fixes 1 and 2 are concrete one-token / one-name edits and are the basis for the
  CHANGES REQUESTED verdict. Fix 3 is a wording tightening.
- The dossier carries the same "54" error (dossier line 20). Section 5 of the
  dossier and CLAUDE.md agree on 53. If the dossier is reused, correct it there too.
