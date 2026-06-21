# Helpdesk - Support tickets and customer portal

> Helpdesk is the public-facing support portal where your customers register, file tickets, track replies, and close out issues. Behind the scenes every ticket spawns a Bam task so your support staff can work it from the project board.

## Overview

Helpdesk gives each organization its own branded support portal. Customers reach it at a public URL, create an account scoped to that org, and submit support requests as tickets. They follow each ticket as a conversation: agents reply, the status moves through its lifecycle, and the customer can attach files, change priority, mark duplicates, reopen, or close.

Customers and agents are two different identities. Customers are end users who live only in Helpdesk; they sign in with an org-scoped email and password that is completely separate from the BigBlueBam (Bam) suite single sign-on. Support agents are your Bam staff users. Agents do not use the customer portal SPA. They work tickets through the agent REST surface and through MCP tools, and they see the matching Bam task inside the Bam app. Every ticket is mirrored to a Bam task on creation, so customer replies, status changes, and closures leave a durable trail on the project board even if the ticket is later deleted.

Helpdesk is multi-tenant. Any organization that has a Helpdesk settings row gets a portal at `/helpdesk/<org-slug>/`, and optionally per-project portals at `/helpdesk/<org-slug>/<project-slug>/`. The portal that a customer lands on determines which org their account and tickets belong to.

The core objects you work with are the **ticket** (the support request), its **messages** (the conversation), its **status** and **priority**, optional **attachments**, and the **settings** that an admin uses to configure each portal.

### Key concepts

- **Portal** - an org's public support site, served at `/helpdesk/<org-slug>/`. Each org with a Helpdesk settings row gets one. Per-project portals are available at `/helpdesk/<org-slug>/<project-slug>/`. The portal a customer lands on decides which org owns their account and tickets.
- **Customer** - an end user with a Helpdesk account scoped to one org. Customers have their own email and password sign-in, separate from the suite single sign-on. They use the portal SPA.
- **Ticket** - a single customer support request. It has a human-readable number shown as `#123`, a subject, a description, a status, a priority, and an optional category. Each ticket is owned by one customer and back-linked to a Bam task.
- **Status** - where the ticket is in its lifecycle. The five canonical statuses are **Open**, **In Progress**, **Waiting on Customer**, **Resolved**, and **Closed**. The stored values are `open`, `in_progress`, `waiting_on_customer`, `resolved`, and `closed`.
- **Priority** - how urgent the ticket is. Customers can set **Low**, **Medium**, or **High**. Agents can additionally set **Critical**. The badge displays all four.
- **Message** - a post on a ticket. Authored by the customer, an agent, or the system. Agent messages flagged as internal notes are hidden from customers.
- **Category** - an optional label chosen from the list an admin configured for the portal. The Category field only appears when categories are configured.
- **Agent** - a support staff member. Agents authenticate with a per-agent agent API key (prefixed `hdag_`) on the agent routes, not with the customer portal. They do not use the customer portal SPA.
- **Admin** - an org owner or admin who configures the portal settings.
- **Duplicate** - a ticket flagged as a copy of another. A customer "mark as duplicate" is annotative: it posts updates on the primary instead. An agent "merge" actually moves the messages onto the primary and closes the source.
- **Attachment** - a file uploaded to a ticket. It appears in the Attachments block once it has been scanned, with a Download link.
- **Bam task** - the project-board task created automatically for every ticket. It lives in the portal's default project so your staff can triage, assign, and track support work alongside other project work.

### Where to find it

The portal is served at `/helpdesk/`. Visiting the bare site root redirects to the Helpdesk portal, so customers normally arrive there by default.

- `/helpdesk/` with no org shows the **Choose your support portal** picker.
- `/helpdesk/<org-slug>/` is a specific org's portal.
- `/helpdesk/<org-slug>/<project-slug>/` is a per-project portal, when one is configured.

A customer needs an account on the org's portal before they can file tickets. This account uses Helpdesk's own customer sign-in, which is separate from the suite single sign-on that staff use for Bam and the other apps; a customer never needs a Bam account. Registration is built in unless the admin has disabled signups. There is no separate install step: any org with a Helpdesk settings row is live.

There is no Knowledge Base in Helpdesk. If you are looking for a searchable knowledge base, that is the separate Beacon app.

![Support portal](screenshots/light/01-portal-entry.png)

## Feature reference

### Choose your support portal (org picker)

This is the landing page when you reach `/helpdesk/` without a specific org. It lists every organization that has a configured portal so you can pick which one to contact.

To choose a portal:

1. Open `/helpdesk/`.
2. Under the heading **Choose your support portal**, read the subtext: "Each organization has its own helpdesk. Pick the one you want to contact."
3. Click the row for the org you want. Each row shows the org name and its `/helpdesk/<slug>/` path.
4. You land on that org's portal.

If no portals are configured, you see the empty state: "No helpdesk portals are configured yet...".

### Register (create an account)

Customers self-register on the org's portal. Each account is scoped to that one org and uses Helpdesk's own customer sign-in, not the suite single sign-on.

To create an account:

1. From the portal, go to the **Create your account** page (the subtext reads "Get support through BigBlueBam Helpdesk").
2. Fill in **Email**, **Display Name**, and **Password**. The password field shows the hint "Min. 12 characters" and must be at least 12 characters.
3. Click **Create Account**.
4. If email verification is not required, you are signed in and taken to your tickets. If it is required, you see a "Check your email" notice.

If signups are disabled for the org, registration returns an error. If the org restricts allowed email domains, an address outside those domains is rejected. An email already in use on that org is rejected as well.

### Login

To sign in:

1. Open the **Welcome back** page (subtext "Sign in to BigBlueBam Helpdesk").
2. Enter your **Email** and **Password**.
3. Click **Sign In**.
4. You land on **My Tickets**.

The footer link "Dont have an account? Create one" sends you to registration. If signups are disabled for the org, that link routes to the Bam beta gate instead. Repeated failed logins lock the account temporarily.

### Verify email

When an org requires email verification, registration sends a link with a token. The verification page reads the token from the URL.

To verify:

1. Open the verification link from your email. The page is titled **Email Verification**.
2. Watch for the status: "Verifying your email...", then either "Your email has been verified!" or "Verification Failed".
3. Click **Go to Login** and sign in.

Verification tokens expire after 24 hours. Note that in a stack without outbound email configured, the verification email is not actually delivered; the token is created but the send is not yet wired up.

### My Tickets list

Your tickets list is the home screen after you sign in. It shows every ticket you own, newest activity first.

To use the list:

1. Open **My Tickets** (the logo and the "My Tickets" nav button both bring you here).
2. Use the search box (placeholder "Search subject, number, or category...") to filter by subject, ticket number, or category.
3. Use the filter chips to narrow by status: **all**, **open**, **in progress**, **waiting on customer**, **resolved**, and **closed**. Each chip maps to a real ticket status, so picking one shows exactly the tickets in that state.
4. Read the columns: **#**, **Subject**, **Status**, **Priority**, **Category**, **Updated**. A **New** dot marks a ticket with activity you have not seen.
5. Click a row to open the ticket.

The list refreshes in real time when a new message is posted or a status changes. If you have no tickets, the empty state reads "No tickets yet" with "Create your first one!". If a search matches nothing, it reads "No tickets match your search."

![My tickets](screenshots/light/02-ticket-list.png)

### New Ticket

This is where a customer files a support request.

To create a ticket:

1. From **My Tickets**, click **New Ticket** (the button with the plus icon). The page is headed **New Ticket** and has a "Back to tickets" link.
2. Fill in **Subject** ("Brief summary of your issue"). This is required.
3. If the portal has categories, choose one from the **Category** select ("Select a category..."). The field is hidden when no categories are configured.
4. Set **Priority** to Low, Medium, or High. Medium is the default. Customers cannot set Critical.
5. Fill in **Description** in the rich-text editor ("Describe your issue in detail..."). This is required. You can paste or upload inline images.
6. Click **Submit Ticket** (or **Cancel** to back out).
7. You land on the new ticket's detail page.

When you submit, the portal creates the ticket and spawns a Bam task in the portal's project so your support staff can work it. If you submit the same subject and description again within an hour, the portal returns your existing ticket instead of creating a duplicate.

![New ticket](screenshots/light/04-new-ticket.png)

### Ticket detail (the conversation)

The ticket detail page is the full conversation and the place to take action on a ticket.

The header shows "#{number} - {subject}", a presence strip of who else is viewing, the **Status** badge, the **Priority** badge with a dropdown, the category chip when set, and "Created on {date}".

The body shows the **Description**, an **Attachments** block, and the timeline of messages and status changes. Your own messages appear on the right labeled "You"; agent and system messages appear on the left. Status changes appear as italic lines, for example "Status changed from X to Y". If the conversation is long, click "Load older messages". When there are no messages yet, the timeline reads "No messages yet."

![Ticket detail](screenshots/light/03-ticket-detail.png)

#### Reply to a ticket

1. Scroll to the reply box at the bottom (it is hidden once a ticket is Resolved or Closed).
2. Type into the rich-text field (placeholder "Type your reply..."). You can add inline images.
3. Click **Send Reply**.

If the ticket was **Waiting on Customer**, sending a reply automatically flips it back to **Open**.

#### Change priority

1. In the header, click the **Priority** badge to open its dropdown.
2. Pick **Low**, **Medium**, or **High**.

#### Close a ticket

1. Click **Close Ticket** in the header.
2. Confirm in the "Close this ticket?" dialog.

Closing the ticket also moves its linked Bam task to a terminal state.

#### Reopen a ticket

1. On a Resolved or Closed ticket, find the banner "This ticket has been resolved." or "This ticket has been closed."
2. Click **Reopen**.

#### Mark as duplicate

Use this when your ticket is a copy of one you already filed.

1. Click **Mark as duplicate** (the copy icon). It is available only when the ticket is not already closed, resolved, or a duplicate.
2. In the **Mark as duplicate** dialog, type the primary ticket's number in the input ("e.g. #123").
3. Click **Confirm** (or **Cancel**).
4. A banner appears: "This ticket was marked as a duplicate of #N... Updates will be posted on that ticket." Updates now go on the primary. The primary ticket shows a "Duplicates of this ticket" callout.

To undo, click **Unmark** in the banner. You cannot unmark if an agent has already merged the ticket.

#### Share to Banter

Use this to hand a ticket off to a Banter channel for internal discussion.

1. Click the **Share to Banter** button (the share icon) in the header.
2. In the popover, headed **Share to Banter**, pick a channel from the **Channel** select ("Select a channel...").
3. Optionally type into the **Message (optional)** field ("Add a note...").
4. Click **Share** (or **Cancel**).

#### Attachments

1. In the **Attachments** block (the paperclip with a count), each file shows its name, size, type, and scan status.
2. Click **Download** to retrieve a file once it has been scanned. Until then it shows **Unavailable**.
3. To add a file, upload it from the ticket. Files are owner-scoped: only the ticket owner can delete an attachment.

### Notifications prompt

On the tickets list, if your browser has not yet been asked, a banner offers browser push notifications: "Get notified when agents respond to your tickets."

To enable:

1. Click **Enable notifications** on the banner.
2. Allow notifications in your browser prompt.

Dismiss the banner with the X if you do not want them. Note that whether a notification actually arrives also depends on the org's notify settings and on outbound email being configured.

### In-app Help

The Help viewer is built into the portal. Press the `?` key from anywhere in the portal to open it; closing it returns you to your tickets. It has no separate page of its own.

### The agent queue (REST and MCP only)

Support agents work tickets through the agent REST surface under `/helpdesk/api/agents/`, not through the customer portal. There is no agent SPA in Helpdesk. Agents authenticate with a per-agent agent API key (prefixed `hdag_`) sent in the `X-Agent-Key` header. A plain Bam session cookie alone is not accepted on the agent routes.

What agents can do on the agent surface:

- List org tickets, filtered by status, assignee, and SLA state, via the agent queue.
- Resolve a ticket by its `#number`, enriched with the requester and the task assignee.
- Search tickets by subject and description.
- Open full ticket detail, including internal notes that customers never see.
- Post a public reply or an internal note. The first agent reply stamps the first-response time.
- Update status, priority, or category.
- Close a ticket.
- Merge duplicates: move the messages onto a primary ticket and close the source.
- Pull a ranked list of similar tickets to find duplicates or related issues.

The agent queue shows an SLA badge for each ticket (breached, imminent, or ok). The badge's first-response target is currently a fixed 4 hours with a 0.75 imminent threshold. This is independent of the per-org SLA setting that the background breach monitor actually enforces (default 8 hours for first response, 48 hours for resolution), so the queue badge and the recorded breach events can disagree. See Related.

Most agents drive these actions through the MCP tools in Working with AI agents below, or through Bam's own ticket views.

### Settings and admin

An admin configures each org's portal. Admins authenticate with a Bam org owner or admin session, or with an `hdag_` agent API key. Settings are org-scoped; the row is created on first save if it does not exist.

Configurable settings:

- **Default project** - the project where incoming tickets create their Bam tasks. Set this from the org's non-archived projects.
- **Default phase** - the phase for newly created tasks.
- **Default priority** - the priority applied by default (low, medium, high, or critical).
- **Categories** - the list of categories customers can choose from on New Ticket.
- **Welcome message** - text shown on the portal.
- **Allowed email domains** - restricts which email domains may register.
- **Require email verification** - whether new customers must verify their email before signing in.
- **Auto-close days** - configured number of days before idle tickets close.
- **Notify on status change** and **Notify on agent reply** - whether to send the customer an email on those events.

To set the default project for incoming tickets:

1. As an admin, open the Helpdesk settings for the org.
2. Choose a project from the org's projects (the picker lists id, slug, and name for each non-archived project).
3. Save. New tickets now create their Bam task in that project. If no default is set, the portal falls back to the project named in the tenant context, then the oldest project.

To disable customer signups:

1. As an admin, set the signup-disabled flag for the org.
2. After that, the registration route returns a "signup disabled" error, and the portal's "Create one" link routes to the Bam beta gate instead of registration.

Note that the SLA minute settings live on the settings row but are not part of the settings update schema; they are editable only directly in the database or through a future UI. Auto-close days and the notify toggles are stored as configuration; confirm with your operator whether the backing automation is enabled in your deployment before relying on them.

### Working with AI agents

Helpdesk exposes 13 MCP tools so agents and automations can triage, answer, search, and configure tickets. They proxy to the Helpdesk API and forward the caller's token, so an agent acts with its own authority. Be aware that the agent surface routes (`/helpdesk/api/agents/`) require an `hdag_` agent API key, so a tool calling those routes acts as a configured support agent, not as a customer.

Reading and finding tickets:

- **list_tickets** - list tickets with optional status, assignee, and client filters.
- **get_ticket** - open a ticket with its messages.
- **helpdesk_get_ticket_by_number** - resolve a `#number` to the full record, enriched with requester and task assignee.
- **helpdesk_search_tickets** - fuzzy search across tickets by subject and body, returning a compact projection ordered by most recently updated.
- **helpdesk_find_similar_tickets** - rank tickets similar to a given one, for finding duplicates or related issues. This is the dedupe surface a triage agent uses before merging.

Acting on tickets:

- **reply_to_ticket** - post a public reply or an internal note. It resolves the ticket number to the record first.
- **update_ticket_status** - change a ticket's status. Its status values are the canonical set: `open`, `in_progress`, `waiting_on_customer`, `resolved`, `closed`.

Configuration and intake:

- **helpdesk_get_public_settings** - read the public settings subset (email-verification requirement, categories, welcome message). No auth required.
- **helpdesk_get_settings** - read the full org settings (admin).
- **helpdesk_update_settings** - edit settings (admin).
- **helpdesk_set_default_project** - set the project that incoming tickets create their Bam task in, by org slug and project slug (admin).
- **helpdesk_upsert_user** - idempotently create or update a customer by org and email, for example from an external system reconciling its user list. The update path never overwrites the password.

Reporting:

- **helpdesk_ticket_count_by_phrase** - count tickets matching a phrase across time buckets, for trend analysis.

Two agent flows are worth calling out for human reviewers:

- **Ticket to Bam task.** Every ticket the portal creates already spawns a Bam task in the default project. An agent working tickets sees the same trail there. When you review an agent's work, check both the ticket conversation and the linked task.
- **Similar-ticket search before merging.** A triage agent should call **helpdesk_find_similar_tickets** to find candidates before merging duplicates. A human should confirm the proposed primary before a merge closes the source ticket, since merge moves messages and is not a customer-reversible action.

Helpdesk also participates in the cross-cutting agentic platform that spans the whole suite:

- **Identity, audit, and heartbeat.** Agent and service callers carry an explicit kind, and their actions are stamped onto the activity trail. Long-running runners report liveness with `agent_heartbeat`. Helpdesk ticket actions show up in this trail like any other app's.
- **Unified activity view.** Helpdesk's per-ticket activity log is one of the sources UNIONed into the platform's unified activity view, so a cross-app agent can see ticket events alongside Bam, Bond, and the rest. Helpdesk uses `actor_type=agent` to mean a human support agent; the platform remaps that to the human kind so it does not collide with the platform's agent identity.
- **Approval queues.** Sensitive proposals can be routed to a durable approval queue (`proposal_create`, `proposal_list`, `proposal_decide`) so a human signs off before an agent acts. Pair this with merges and bulk status changes.
- **Visibility preflight.** Before an agent posts ticket content into a shared cross-app surface, it must call `can_access` for every cited entity and drop anything the asker is not allowed to see.
- **Agent policies and outbound webhooks.** A per-agent kill switch and tool allowlist (the `helpdesk.*` prefix among them) gate which Helpdesk tools an agent may call, and outbound webhooks push subscribed Helpdesk Bolt events (ticket created, message posted, status changed, closed, reopened, user upserted, SLA breached) to agent runners.

For the complete tool catalog, see the MCP tools reference in `docs/apps/helpdesk/`.

## Working together (live presence)

BigBlueBam treats collaboration as ambient, not as a scheduled meeting. When you open a ticket, a presence strip shows who else is on it, so support and engineering can drop into a huddle on the same ticket instead of trading messages. Voice and video here are the digital version of bumping into a colleague in the hallway or stopping by their desk: a quick question, a shared look at the same thing, then back to work. Your presence travels with you across the suite through the Bureau virtual office. The Introduction covers the full pervasive-presence model.

## User Stories

### Story: File your first support ticket

**Who:** A customer reaching support for the first time.
**Goal:** Get a support request in front of an agent.
**Before you start:** Know which organization you need support from. Signups must be enabled on that org's portal. You do not need a Bam suite account; Helpdesk has its own customer sign-in.

**Steps**

1. Go to `/helpdesk/`. On the **Choose your support portal** page, click your org's row.
2. On the portal, open **Create your account**. Enter **Email**, **Display Name**, and a **Password** of at least 12 characters, then click **Create Account**.
3. If the org requires verification, open the link in your email, wait for "Your email has been verified!", click **Go to Login**, and sign in.
4. On **My Tickets**, click **New Ticket**.
5. Fill in **Subject** and **Description**. Pick a **Category** if the portal offers one, and set **Priority** (Low, Medium, or High).
6. Click **Submit Ticket**.

**Result:** You land on the ticket's detail page with a ticket number like `#123`. Behind the scenes a Bam task is created so support staff can pick it up.

**Related:** Track and reply to a ticket; an agent can intake a customer with **helpdesk_upsert_user**.

### Story: Track a ticket and reply to an agent

**Who:** A customer with an open ticket.
**Goal:** Read the agent's reply and respond.
**Before you start:** You have filed at least one ticket and are signed in.

**Steps**

1. Open **My Tickets**. Rows with a **New** dot have activity you have not seen.
2. Click the ticket to open it.
3. Read the timeline. Agent and system messages are on the left; your own are on the right.
4. In the reply box, type into "Type your reply...".
5. Click **Send Reply**.

**Result:** Your reply appears in the timeline. If the ticket was **Waiting on Customer**, it flips back to **Open**.

**Related:** Attach a file or inline image.

### Story: Filter your tickets by status

**Who:** A customer with several tickets.
**Goal:** Narrow the list to just the tickets in one state.
**Before you start:** You are on **My Tickets** with more than one ticket.

**Steps**

1. Above the list, find the filter chips: **all**, **open**, **in progress**, **waiting on customer**, **resolved**, **closed**.
2. Click the chip for the status you want, for example **waiting on customer** to see the tickets where the agent is waiting on you.
3. Click **all** to clear the filter.

**Result:** The list shows only the tickets in the chosen state. You can combine a chip with the search box to narrow further.

**Related:** My Tickets list feature.

### Story: Attach a file or inline image

**Who:** A customer who needs to send a screenshot, log, or document.
**Goal:** Get a file onto the ticket.
**Before you start:** The ticket is open (the reply box is hidden once a ticket is Resolved or Closed).

**Steps**

1. Open the ticket.
2. To send an inline image, paste or upload it into the rich-text reply or description editor.
3. To send a file, add it as an attachment from the ticket.
4. Find it in the **Attachments** block.

**Result:** The file shows its name, size, type, and scan status. A **Download** link appears once it has been scanned; until then it shows **Unavailable**.

### Story: Change a ticket's priority

**Who:** A customer whose issue became more or less urgent.
**Goal:** Reset the priority.
**Before you start:** You are on the ticket detail page.

**Steps**

1. In the header, click the **Priority** badge to open its dropdown.
2. Choose **Low**, **Medium**, or **High**.

**Result:** The badge updates. Customers cannot set Critical; only agents can.

### Story: Mark a ticket as a duplicate

**Who:** A customer who filed the same issue twice.
**Goal:** Point this ticket at the original so updates land in one place.
**Before you start:** You know the primary ticket's number. The ticket you are marking is not already closed, resolved, or a duplicate.

**Steps**

1. Open the duplicate ticket and click **Mark as duplicate**.
2. In the dialog, type the primary ticket's number ("e.g. #123").
3. Click **Confirm**.

**Result:** A banner says the ticket is a duplicate of #N and updates will be posted on that ticket. The primary shows a "Duplicates of this ticket" callout. Click **Unmark** to undo, as long as an agent has not merged it.

### Story: Close a ticket, then reopen it

**Who:** A customer whose issue is resolved, or who needs to reopen one.
**Goal:** Close a settled ticket, or reopen one that turned out not to be done.
**Before you start:** You are on the ticket detail page.

**Steps**

1. To close, click **Close Ticket** and confirm "Close this ticket?".
2. To reopen later, find the "This ticket has been resolved." or "This ticket has been closed." banner and click **Reopen**.

**Result:** Closing also moves the linked Bam task to a terminal state. Reopening returns the ticket to an active state and brings back the reply box.

### Story: Share a ticket to a Banter channel

**Who:** A customer or agent who wants to discuss a ticket in chat.
**Goal:** Post a link to this ticket into a Banter channel.
**Before you start:** You can see the ticket and have at least one Banter channel available.

**Steps**

1. On the ticket, click the **Share to Banter** button.
2. In the popover, pick a channel from the **Channel** select.
3. Optionally add a note in **Message (optional)**.
4. Click **Share**.

**Result:** The ticket is posted to the chosen Banter channel.

### Story: Turn on browser notifications

**Who:** A customer who wants to know the moment an agent replies.
**Goal:** Get a browser push when there is ticket activity.
**Before you start:** You are on the **My Tickets** list and your browser has not been asked yet.

**Steps**

1. On the banner "Get notified when agents respond to your tickets.", click **Enable notifications**.
2. Allow notifications in the browser prompt.

**Result:** Your browser is permitted to show ticket notifications. Whether one arrives also depends on the org's notify settings and on outbound email being configured.

### Story: Work the agent queue

**Who:** A support agent.
**Goal:** Triage and answer tickets.
**Before you start:** You have a per-agent agent API key (prefixed `hdag_`). A Bam session alone is not accepted on the agent routes.

**Steps**

1. Pull the agent queue, filtered by assignee, status, or SLA state, with **list_tickets** or by querying the agent queue route directly. Each ticket carries an SLA badge.
2. Open a ticket with **get_ticket** (or resolve a `#number` first with **helpdesk_get_ticket_by_number**). As an agent you see internal notes that customers do not.
3. Reply with **reply_to_ticket**, choosing a public reply or an internal note.
4. Move the ticket forward with **update_ticket_status**, using a canonical status (open, in_progress, waiting_on_customer, resolved, closed).
5. Close the ticket when it is done.

**Result:** The ticket reflects your reply and new status. The linked Bam task is updated in step with the ticket.

**Related:** Merge duplicates; note that the queue's SLA badge target is a fixed 4 hours and may not match the org's configured SLA.

### Story: Merge duplicate tickets

**Who:** A support agent cleaning up duplicate reports.
**Goal:** Consolidate two tickets into one.
**Before you start:** You have agent access and a candidate ticket that may be a duplicate.

**Steps**

1. Call **helpdesk_find_similar_tickets** on the ticket to get a ranked list of candidates.
2. Confirm which ticket is the true primary.
3. Merge the source into the primary through the agent merge action.

**Result:** The source ticket's messages move onto the primary and the source is closed. Unlike a customer's "mark as duplicate", an agent merge is not customer-reversible, so confirm the primary before merging.

### Story: Set up a new support portal

**Who:** An org admin or owner.
**Goal:** Configure the org's portal so tickets route correctly.
**Before you start:** You have a Bam admin or owner session, or an `hdag_` agent key. The org has at least one project.

**Steps**

1. Open the org's Helpdesk settings (read them with **helpdesk_get_settings**).
2. Set the **Default project** so incoming tickets create their Bam task in the right place. Use **helpdesk_set_default_project** or set `default_project_id` directly.
3. Set the **Categories** customers can choose from, a **Welcome message**, and a **Default priority**.
4. Restrict **Allowed email domains** and decide whether to **Require email verification**.
5. Save with **helpdesk_update_settings**. The settings row is created if it did not exist.

**Result:** The portal is configured. New tickets land in the right project, and customers see your categories and welcome message.

**Related:** Disable signups by setting the signup-disabled flag; after that the "Create one" link routes to the Bam beta gate.

### Story: Reconcile a customer from an external system

**Who:** An admin or an integration agent.
**Goal:** Make sure a customer exists in Helpdesk without disturbing an existing account.
**Before you start:** You have admin authority and the org slug. The intake request must carry the org context.

**Steps**

1. Call **helpdesk_upsert_user** with the org slug and the customer's email.
2. Provide the display name and any other fields.

**Result:** The customer is created if new, or updated if they already exist, matched on org and email. The password is never overwritten on update. A `user.upserted` event is emitted for downstream automations.

### Story: Report on ticket trends

**Who:** An admin or agent watching support load.
**Goal:** See how often a phrase appears in tickets over time.
**Before you start:** You have admin authority.

**Steps**

1. Call **helpdesk_ticket_count_by_phrase** with the phrase you want to track.
2. Choose the time buckets (for example by hour, day, or week) and the time window.

**Result:** A time-bucketed count of tickets matching the phrase, which you can use to spot spikes or recurring issues.

## Flagged behavior (known mismatches)

These are real behaviors in the current code that can surprise you. Document them so users do not chase them as bugs.

- **No Knowledge Base in Helpdesk.** Some older guide material describes a Helpdesk knowledge base. There is no such feature in the Helpdesk code. The knowledge base product is the separate **Beacon** app. Do not look for a KB in Helpdesk.
- **Agent-queue SLA badge target is fixed.** The agent queue's SLA badge uses a fixed 4-hour first-response target with a 0.75 imminent threshold. The actual breach monitor uses the per-org SLA settings (default 8 hours for first response, 48 hours for resolution). The badge and the recorded breaches can therefore disagree.

## Related

- **Bam** - every ticket spawns and stays linked to a Bam task in the portal's default project. Agents work tickets from Bam's ticket views and project board. Closing a ticket moves its task to a terminal state.
- **Banter** - share a ticket into a Banter channel with the **Share to Banter** action for internal discussion.
- **Beacon** - the actual knowledge base product. Helpdesk has no knowledge base of its own.
- **Bolt** - Helpdesk emits ticket lifecycle events (created, message posted, status changed, closed, reopened, user upserted, and SLA breached) that Bolt automations can react to.
- MCP tools reference and the app guide live in `docs/apps/helpdesk/`. The 13 Helpdesk MCP tools are listed under Working with AI agents above.
