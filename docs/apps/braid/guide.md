---
title: "Braid (Identity Resolution and Golden Records) Guide"
app: braid
---

# Braid (Identity Resolution and Golden Records) Guide

# Braid - Customer identity resolution

Braid is BigBlueBam's identity-resolution and customer-data platform: it braids every app's copy of a person or company into one confidence-scored golden profile, with a human-in-the-loop review queue for the merges it is not sure about. The same customer today exists as a Bond contact, a Bill client, a Helpdesk requester, and one row per booking in Book, and nothing in the suite decides they are one person. Braid is the decider. Its flagship operation, resolve, returns a stable golden id for any source record, so every other app's counts, sends, and rollups can group by the same person. Braid never owns source data and never edits a Bond contact; it maintains a separate golden layer that points back at the records it consolidates.

## Key Features

- **Golden profiles from AI identity resolution.** Braid clusters source records into one profile per real person or company using a reproducible, auditable score built from typed features (exact email, exact phone, name similarity, embeddings, domain match, and a platform-user signal). Every link carries an evidence trail that reconstructs its score.
- **Three confidence bands with human-in-the-loop review.** High-confidence pairs with a strong signal auto-merge; middling pairs are queued as candidates for a human to confirm or reject; low-confidence pairs are left alone and suppressed for a cooldown. Defaults are an auto-merge threshold of 0.92 and a review threshold of 0.60, both tunable per org.
- **Merge and split, fully reversible.** Confirm a queued candidate, or merge two profiles directly from a profile's detail page. Every merge records exactly which identities it moved, so any merge can be split apart deterministically, either by undoing a specific merge or by peeling selected identities into a fresh profile.
- **Survivorship rules.** Per-org, per-field rules decide which linked source wins when a profile's members disagree on a value, with five strategies: most recent, source priority, longest non-null, most frequent, and manually pinned.
- **Per-viewer PII assembly.** A golden profile is the richest PII object in the suite, so Braid re-derives every field, identity, and timeline row per viewer: fields sourced from records you cannot see are dropped, and the identity count and confidence are recomputed over only what you are allowed to see. The full profile read is admin-tier; the narrow resolve operation is a separate non-admin permission.
- **Five source types, opt-in per org.** Braid ingests `bond.contact`, `bond.company`, `bill.client`, `helpdesk.user`, and `book.event_attendee`. Blast is not a source type. A source type is only ingested once it is enabled in Settings and its visibility rules are supported.
- **AI agent surface** of 13 `braid_*` MCP tools covering resolve, read, search, timeline, propose, reject, merge, split, and survivorship rules, with two-step confirmation on merge and split, `asker_user_id` gating on reads, and `agent_policies` fail-closed allowlisting.

## Integrations

Braid reads the source records owned by **Bond** (contacts and companies), **Bill** (clients), **Helpdesk** (requesters), and **Book** (event attendees); it never owns or edits that data. **Bond**'s own duplicate finder dedupes within Bond, while Braid resolves across all four apps and maintains a durable golden record. **Bench** charts data and **Basis** defines metrics; Braid produces the golden entity that a distinct-customers chart should group by and that a Basis per-customer metric is only trustworthy over once the customers are deduplicated. Identity changes publish `profile.merged`, `profile.split`, `profile.matched`, and `candidate.created` events (references and magnitude only, never PII) on the `braid` source to **Bolt**, so an automation rule can route them into a **Banter** channel, an email, or a webhook. Agents reach Braid under an identity with `agent_policies` gating, and reads that surface source records require the human's `asker_user_id` so per-record visibility is enforced for the person the agent acts for.

## Getting Started

1. Open **Braid** from the Launchpad (or go to `/braid/`). You are signed in already if you are signed in to the suite.
2. On the **Settings** page, enable the source types Braid should resolve and set the **Auto-merge threshold** and **Review threshold** for your org.
3. On the **Golden profiles** page, search by name, email, or phone and open a profile to see every source record it consolidates in **Member identities**, plus its **Cross-app timeline** and **Decisions & audit**.
4. Work the **Review Queue**: expand **Evidence** on a candidate and click **Confirm** to merge or **Reject** to record a no-match. Merge two profiles directly, or split a wrong merge apart, from a profile's **Merge & split** section. Set which source wins per field on the **Survivorship** page.

For the full click-by-click walkthroughs, key concepts, and user stories, see the in-app Help Center (the **?** button), sourced from `docs/apps/braid/help.md`.

## Related

- **Bond, Bill, Helpdesk, Book** - own the source records Braid resolves.
- **Bench** - charts the data; Braid supplies the golden entity a distinct-customers measure groups by.
- **Basis** - defines and explains metrics; a per-customer metric is trustworthy only once Braid deduplicates the customers.
- **Bolt** - receives Braid's identity-change events so they can be routed anywhere in the suite.
- **Braid MCP-tools reference** - the full `braid_*` tool catalog and confirmation behavior; see `docs/reference/mcp-endpoint-mapping.md`.
