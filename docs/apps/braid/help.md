# Braid - Identity Resolution and Golden Records

> Braid braids every app's copy of a person or company into one confidence-scored golden profile, with a human-in-the-loop review queue for the merges it is not sure about. Reach for Braid when the same customer exists as a Bond contact, a Bill client, and a handful of Book attendees, and nothing in the suite decides they are one person.

## Overview

Braid is BigBlueBam's identity-resolution and customer-data platform. The same real person is scattered across the suite: a Bond contact, a Bill client, a Helpdesk requester, and one row per booking in Book. Nothing decides that those rows are the same person, so no count of customers can be trusted. Braid is the decider. It clusters those source records into one confidence-scored golden profile per real-world person or company, attaches an evidence trail to every link, and routes the merges it is unsure about to a human reviewer.

Braid does two jobs. First, resolution: an AI core scores each candidate pair from typed, reproducible features (exact email, exact phone, name similarity, embeddings, domain, and a platform-user signal), then either merges high-confidence pairs automatically, queues middling pairs for review, or leaves low-confidence pairs alone. Second, a durable golden record: every profile points back at the source rows it consolidates, so a merge is fully auditable and every merge can be split apart again.

Braid deliberately does not own source data and never edits a Bond contact or a Bill client. It reads those apps and maintains a separate golden layer that references them. Its flagship operation is resolve: hand it any source record and it returns a stable golden id, so every other app's counts, sends, and rollups can group by the same person.

The objects you work with are golden profiles (the resolved record), identities (each source-app row that a profile consolidates), match candidates (proposed merges awaiting a human decision), merge and split decisions (the immutable audit trail), survivorship rules (which source wins per field), and per-org settings (the thresholds and enabled sources).

Braid is for the org admin, RevOps, and support-ops persona who today reconciles duplicates by hand. Because a golden profile is consolidated cross-app PII, the full profile read defaults to an admin-tier permission, while the narrow resolve operation is a separate, non-admin permission so per-app callers and service accounts can drive it safely.

### Key concepts

- **Golden profile** - the resolved record for one real person or company. It carries a display name, primary email and phone, a linked identity count, a confidence score, and a status (`Active`, `Merged away`, or `Archived`). Its field values are re-derived from its member identities and the survivorship rules, and re-assembled per viewer so you only ever see fields sourced from records you are allowed to see.
- **Identity** - one source-app row mapped into a golden profile. Each identity records its `source_type` (`bond.contact`, `bond.company`, `bill.client`, `helpdesk.user`, or `book.event_attendee`), its source id, and how it was linked (`auto`, `human`, or `seed`).
- **Source type** - one of the five backing record types Braid ingests: `bond.contact`, `bond.company`, `bill.client`, `helpdesk.user`, `book.event_attendee`. Blast is not a source type. A source type is only ingested once it is enabled for your org in Settings.
- **Match candidate** - a proposed merge of two profiles that scored in the review band. It carries the score, the evidence (either a direct pairwise comparison or a bridged link through a shared identity), and an optional plain-language rationale. It sits in the Review Queue until a human confirms or rejects it.
- **Merge** - combining two golden profiles into one surviving profile. Confirmed from the Review Queue, or run directly from a profile's detail page.
- **Split** - pulling identities back out of a profile: either undoing a specific past merge or peeling selected member identities into a fresh profile. Splits are always possible because every merge records exactly which identities it moved.
- **Confidence bands** - Braid sorts every candidate pair into one of three bands by its score against your org thresholds. **Auto-merge** (score at or above the auto-merge threshold, with at least one strong signal) links automatically. **Review** (score between the review and auto-merge thresholds) queues a candidate for a human. **No-op** (score below the review threshold) is left alone and suppressed for a cooldown so it is not rescored every tick. Defaults are an auto-merge threshold of 0.92 and a review threshold of 0.60.
- **Survivorship rule** - a per-org, per-field rule that decides which linked source wins when the member identities disagree on a value. One of five strategies: most recent, source priority, longest non-null, most frequent, or manually pinned.
- **Evidence** - the reproducible feature breakdown behind a candidate's score. Its full weight set is snapshotted so an old candidate re-renders the same score even after you change thresholds or weights.
- **braid_resolve** - the flagship operation and tool: resolve a source record to its stable golden id, following the merge chain, minting a singleton profile if the record has never been seen.

### Where to find it

Braid is served at `/braid/`. Reach it from the **Launchpad** in the top bar of any app (its tile is named **Braid** and labeled **Customer Identity**), or go straight to `/braid/`. Braid shares your BigBlueBam session, so if you are signed in to the suite you are signed in to Braid.

Before Braid is useful you need an organization with source data in the apps it reads (Bond contacts and companies, Bill clients, Helpdesk requesters, Book attendees), and at least one source type enabled in Settings. Reading golden profiles and the review queue needs the `braid.profile.read` and `braid.candidate.read` permissions (admin-tier by default); merging and splitting are gated by `braid.profile.merge` and `braid.profile.split`; the narrow resolve operation is gated by the separate, non-admin `braid.profile.resolve` permission. Braid ships 9 permissions in total.

## Feature reference

Four pages ship, matching the left sidebar: **Profiles**, **Review Queue**, **Survivorship**, and **Settings**. The sidebar carries the Braid badge, the four nav items, and the shared account footer. The top bar has the **Launchpad**, a breadcrumb, your organization switcher, the notifications bell, the **?** help button (which opens this help), and your user menu.

### Browsing the Profile Catalog

The **Profiles** page (its heading reads **Golden profiles**) is the Braid home page. It lists every golden profile in your organization in a table with **Name**, **Kind**, **Contact**, **Identities**, **Confidence**, **Status**, and **Updated** columns. The **Kind** column shows a **Person** or **Company** badge; the **Status** column shows **Active**, **Merged away**, or **Archived**.

To browse and filter profiles:

1. Open `/braid/`. The catalog loads with your profiles.
2. Type in the search box (placeholder **Search name, email, phone**) to match on name, email, or phone.
3. Use the kind dropdown (**All kinds** by default) to narrow to **Person** or **Company**.
4. Use the status dropdown (**All statuses** by default) to narrow to **Active**, **Merged away**, or **Archived**.
5. Click any row to open that profile's detail page.

If no profiles match, the page shows **No profiles yet** and notes that profiles are minted automatically as source records resolve.

### Opening a golden-profile detail

Clicking a catalog row opens the profile detail page. The header shows the display name, primary email and phone, the count of linked identities, the confidence percentage, and when it was last updated. Below the header are four sections.

- **Member identities** lists each source record consolidated into this profile, showing its `source_type` badge, its source id, how it was linked (`auto`, `human`, or `seed`), and when. Each row has a checkbox used by the split action. A non-admin viewer only sees the identities they are allowed to see; denied identities are dropped entirely and the count is recomputed.
- **Cross-app timeline** lists activity and events tied to this profile's member identities, newest first. A row appears only if it maps to a member identity whose source record you are allowed to see.
- **Decisions & audit** lists every merge and split recorded for this profile, each with its kind, date, the actor that decided it, an optional reason, and the count of affected identities.
- **Merge & split** holds the actions described below.

To open a profile:

1. On the **Profiles** page, click the row for the person or company.
2. Read the header for the resolved name, contact details, identity count, and confidence.
3. Scroll through **Member identities**, **Cross-app timeline**, and **Decisions & audit** to see what the profile consolidates and how it got there.

### The Merge Review Queue

The **Review Queue** page (heading **Merge review queue**) holds the candidate pairs that scored in the review band and need a human decision. It lists pending candidates sorted by score, each showing the score percentage, the two profile ids (each a link to its detail page), an optional rationale, and when it was queued.

To review and decide a candidate:

1. Open **Review Queue** from the sidebar.
2. For a candidate, click **Evidence** to expand the reproducible feature breakdown. A direct candidate lists each feature (`email_exact`, `phone_exact`, `name_trigram`, and so on) with its score and weight; a bridged candidate shows the shared identity that linked the two profiles and each of its two links.
3. Click either profile id to open its detail page in a new view if you need to inspect the members first.
4. Click **Confirm** to merge the two profiles, or **Reject** to record a lasting no-match.

**Result:** Confirming merges the pair through the same executor the queue and the direct merge share, and the candidate leaves the queue. Rejecting writes an identity-level suppression so the same bridging pair does not re-surface on the same evidence. If the queue is empty the page shows **Queue is empty**.

### Merging two profiles directly

When you already know two profiles are the same person, you do not have to wait for a candidate. The **Merge & split** section of a profile's detail page has a **Merge with another profile** control.

To merge directly:

1. Open the surviving profile you want to keep from the **Profiles** page.
2. Scroll to **Merge & split**, then **Merge with another profile**.
3. Paste the other profile's id into **Other profile ID**.
4. Optionally type a **Reason** (for example `Confirmed same person`).
5. Click **Merge**.

**Result:** The two profiles merge and you land on the surviving profile, with the confirmation **Merged. Now viewing the surviving profile.** The merge is recorded in **Decisions & audit** and can be undone with a split.

### Splitting a profile

When a merge was wrong, or a profile has picked up an identity that does not belong to it, split it apart. The **Merge & split** section offers two ways to split.

To peel selected identities into a fresh profile:

1. Open the profile from the **Profiles** page.
2. In **Member identities**, check the identities that do not belong to this profile.
3. Scroll to **Merge & split**, then **Split off checked identities**.
4. Optionally type a **Reason** (for example `Wrongly merged`).
5. Click **Split** (the button shows the count of checked identities).

To undo a specific past merge:

1. Open the profile and scroll to **Merge & split**.
2. Under **Undo a past merge**, click the **Undo merge from <date>** button for the merge you want to reverse. This section only appears when the profile has a recorded merge.

**Result:** The split runs and you see **Split complete.** or **Unmerged successfully.** The affected identities move to their own profile, and because every merge recorded exactly which identities it moved, the original cluster is rebuilt deterministically.

### Editing Survivorship rules

The **Survivorship** page (heading **Survivorship rules**) controls which linked source wins when a profile's member identities disagree on a field value. It has **Person** and **Company** tabs; each shows a rule editor per field, starting with `display_name`, `primary_email`, and `primary_phone`.

To edit a rule:

1. Open **Survivorship** from the sidebar and choose the **Person** or **Company** tab.
2. For a field, pick a **strategy** from the dropdown: **Most recent value wins**, **Source priority order**, **Longest non-null value**, **Most frequent value**, or **Manually pinned value**.
3. If you chose **Source priority order**, check the sources to include, then order them highest priority first with the up and down arrows.
4. If you chose **Manually pinned value**, type the exact **Pinned value** to always use.
5. Click **Save rule**. The button reads **Saved** briefly on success.

To add a rule for a field that is not listed:

1. Under **Add a custom field**, type the field name (for example `attributes.title`).
2. Click **Add field**, then configure and save its rule as above.

**Result:** The next time two profiles with that kind merge, the saved strategy decides which member value wins for that field.

### Settings (thresholds and enabled sources)

The **Settings** page tunes the decision bands and controls which source types Braid resolves. It has three sections.

To tune the decision thresholds:

1. Open **Settings** from the sidebar.
2. Under **Decision thresholds**, set the **Auto-merge threshold (0-1)** and the **Review threshold (0-1)**. Scores at or above the auto-merge threshold link automatically; scores between the two thresholds are queued for review; lower scores are ignored.
3. Leave **Require at least one strong signal for auto-merge** checked to keep embedding-only high scores out of the auto-merge band and route them to review instead.
4. Click **Save settings**.

To control which sources are ingested:

1. Under **Enabled source types**, check the source types Braid should ingest and resolve. Only records from an enabled type become golden profiles.
2. Click **Save settings**. Enabling a source whose visibility rules are not yet supported is rejected with a typed error.

To adjust the rescan cadence:

1. Under **Rescan cadence**, set **Max rescan age (days)**, or leave it blank for the default. The nightly rescan diffs each enabled source table directly, so a dropped live event still resolves the next day rather than leaving a stale blind spot.
2. Click **Save settings**.

The page also notes **Last full rescan** when a rescan has run.

### Working with AI agents

Braid exposes 13 MCP tools so agents resolve and manage the same golden records you do. The read tools are `braid_resolve` (the flagship, resolve a source record to its golden id), `braid_get_profile` (returns the profile with its member identities and recent decisions embedded), `braid_list_profiles`, `braid_search_profiles`, `braid_profile_timeline`, `braid_list_candidates`, `braid_list_survivorship_rules`, and `braid_get_settings`. The write tools are `braid_propose_merge`, `braid_reject_candidate`, `braid_merge_profiles`, `braid_split_profile`, and `braid_set_survivorship_rule`.

Three things a human should know about agent work in Braid:

- **Reads that surface source records take an `asker_user_id`.** `braid_resolve`, `braid_get_profile`, `braid_list_profiles`, `braid_search_profiles`, `braid_profile_timeline`, and `braid_propose_merge` accept the id of the human the agent acts for, and Braid filters every field, identity, and timeline row to what that person is allowed to see. Passing an asker only ever narrows the view, never widens it.
- **Merge and split are two-step confirmed.** `braid_merge_profiles` and `braid_split_profile` are truth-flips. The agent calls once without a `confirm_token` to stage a Redis-backed token, then calls again with the returned token to execute, so a reviewer can catch an unintended flip. A denied input record on resolve returns not found, never a golden id.
- **Proposing a merge is the human-in-the-loop, not the merge.** `braid_propose_merge` upserts a candidate and registers it in the org-admin approval inbox, so approval flows through the same executor the Review Queue uses. `braid_reject_candidate` records a lasting no-match. Every `braid.*` service-account call fails closed until an operator allowlists `braid.*` for that agent.

For the full catalog, argument shapes, and confirmation behavior see the Braid MCP-tools reference in `docs/reference/mcp-endpoint-mapping.md`.

## User Stories

### Story: Find the duplicates of a customer

**Who:** Skipper, an org owner who suspects one castaway exists several times across the suite.
**Goal:** See the single golden profile for a person and every source record it consolidates.
**Before you start:** You are signed in, you have the `braid.profile.read` permission, and the relevant source types are enabled in Settings.

**Steps**

1. Open the **Launchpad** and choose **Braid** (or go to `/braid/`).
2. On the **Golden profiles** page, type the person's name, email, or phone into the search box.
3. Narrow with the kind dropdown to **Person** if needed.
4. Click the matching row to open its detail page.
5. Read **Member identities** to see every source record (Bond contact, Bill client, Book attendees, and so on) that resolved into this one person.

**Result:** You see one golden profile with its resolved name, contact details, and identity count, and the full list of source rows it braids together across apps. An agent can do the same by calling `braid_resolve` on any of those source records, or `braid_get_profile` to pull the members and recent decisions in one call.

**Related:** Confirm a suggested merge; Undo a wrong merge.

### Story: Confirm a suggested merge

**Who:** Mary Ann, doing a weekly pass over Braid's review queue.
**Goal:** Approve a proposed merge after checking the evidence.
**Before you start:** There are pending candidates and you have the `braid.profile.merge` permission.

**Steps**

1. Open **Review Queue** from the sidebar.
2. Find the candidate at the top (the queue is sorted by score) and read its score percentage and rationale.
3. Click **Evidence** to expand the feature breakdown, and confirm the signals (for example an `email_exact` match) justify the merge.
4. If you want to inspect the members first, click either profile id to open its detail.
5. Click **Confirm**.

**Result:** The two profiles merge into one surviving profile and the candidate leaves the queue. The merge is recorded in the surviving profile's **Decisions & audit**. If the evidence was not convincing, click **Reject** instead to record a lasting no-match.

**Related:** Undo a wrong merge. An agent proposes candidates with `braid_propose_merge` and rejects with `braid_reject_candidate`.

### Story: Undo a wrong merge

**Who:** The Professor, who realizes two different people were merged into one profile.
**Goal:** Split the wrongly merged identities back out without losing history.
**Before you start:** The profile exists, it has a recorded merge, and you have the `braid.profile.split` permission.

**Steps**

1. Open the affected profile from the **Profiles** page.
2. In **Member identities**, check the identities that do not belong to this profile.
3. Scroll to **Merge & split**, then **Split off checked identities**, and optionally type a **Reason** such as `Wrongly merged`.
4. Click **Split**. Alternatively, under **Undo a past merge**, click **Undo merge from <date>** to reverse a specific prior merge exactly.

**Result:** The checked identities move into a fresh profile (or the prior merge is fully reversed), you see **Split complete.** or **Unmerged successfully.**, and the split is added to **Decisions & audit**. An agent does the same with `braid_split_profile`, which requires a two-step confirm token.

**Related:** Confirm a suggested merge.

### Story: Tune when Braid auto-merges

**Who:** Skipper, deciding Braid is merging too aggressively (or not enough).
**Goal:** Change the score thresholds that separate auto-merge, review, and no-op.
**Before you start:** You have the `braid.settings.write` permission.

**Steps**

1. Open **Settings** from the sidebar.
2. Under **Decision thresholds**, raise **Auto-merge threshold (0-1)** to make automatic merges rarer, or lower it to make them more common.
3. Adjust **Review threshold (0-1)** to control how weak a match still lands in the Review Queue rather than being ignored.
4. Keep **Require at least one strong signal for auto-merge** checked so a high embedding-only score is queued for review instead of merged automatically.
5. Click **Save settings**.

**Result:** New candidate pairs are banded against the updated thresholds. Raising the auto-merge threshold sends more borderline pairs to the Review Queue; lowering the review threshold surfaces more weak pairs for a human. An agent reads the current thresholds with `braid_get_settings`.

**Related:** The Merge Review Queue; Editing Survivorship rules.

### Story: Resolve and propose a merge from an agent

**Who:** An AI assistant reconciling a newly imported list of clients.
**Goal:** Resolve each record to its golden id and, where two golden profiles look like the same person, propose a merge for a human to approve.
**Before you start:** The agent's service account has been allowlisted for `braid.*` in agent policies, and the agent has the human's `asker_user_id`.

**Steps**

1. The agent calls `braid_resolve` with the record's `source_type` and `source_id` (and the `asker_user_id`) to get the stable golden id. A record the asker cannot see returns not found.
2. The agent calls `braid_get_profile` on two golden ids to compare their members and confidence.
3. When they look like one person, the agent calls `braid_propose_merge` with both profile ids and a reason. The proposal lands in the org-admin approval inbox as a review candidate.
4. A human opens the **Review Queue**, inspects the **Evidence**, and clicks **Confirm** or **Reject**.

**Result:** The agent never merges autonomously. It only proposes; a human approves through the same queue and executor as any other candidate. If the agent instead calls `braid_merge_profiles` directly, the tool returns a confirmation token first and waits for a confirmed second call.

**Related:** Confirm a suggested merge; Working with AI agents.

## Related

- **Bond, Bill, Helpdesk, Book** - own the source records Braid resolves. Braid reads their contacts, companies, clients, requesters, and attendees; it never owns or edits that data. Bond's own duplicate finder dedupes within Bond, while Braid resolves across all four apps and keeps a durable golden record.
- **Bench** - charts data. Braid does not draw charts; it produces the golden entity that a chart's distinct-customers measure should group by.
- **Basis** - defines a metric once and explains why it moved. A Basis metric grouped by customer is only trustworthy once Braid has deduplicated the customers; Braid resolves the entities a metric decomposes over.
- **Bolt** - receives Braid's `profile.merged`, `profile.split`, `profile.matched`, and `candidate.created` events (refs and magnitude only), so you can route identity changes into Banter, email, or a webhook.
- **Braid MCP-tools reference** - the full catalog of the 13 `braid_*` tools, arguments, and confirmation behavior for agents. See the surface map in `docs/reference/mcp-endpoint-mapping.md`, and the Braid guide in `docs/apps/braid/guide.md`.
