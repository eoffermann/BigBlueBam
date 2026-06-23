# Beacon - Knowledge base with freshness governance

> Beacon is your team's knowledge base: a place to write, search, link, and keep
> articles current. It is the app you reach for when knowledge needs to stay
> accurate over time, not just get written once and forgotten.

## Overview

Beacon stores your team's knowledge as **Beacons** (knowledge articles). Each
Beacon has a title, a short summary, a Markdown body, an owner, a visibility
level, and an expiry date. Beacons move through a lifecycle (Draft, Active,
Pending Review, Archived, Retired) and carry a freshness signal so stale
knowledge surfaces before it misleads anyone.

Beyond plain storage, Beacon connects articles into a **Knowledge Graph** of
typed links and shared tags, runs **hybrid search** (semantic plus tags plus
link traversal plus keyword fallback), and gives governance owners a
freshness-focused dashboard for keeping the library verified. Expiry policies
let an org set how long knowledge stays trusted before it needs re-verification.

Beacon is part of the BigBlueBam suite. It shares your platform login with Bam
and the other apps, pulls its project list from Bam, and publishes lifecycle
events to Bolt so automations can react when knowledge is created, updated,
verified, or retired.

### Key concepts

- **Beacon** - A single knowledge article. Has a globally unique slug, a title,
  a summary (up to 500 characters), a Markdown body, a version number, a status,
  a visibility, an owner, an optional project, and an expiry date.
- **Status** - The article's place in its lifecycle. The five statuses you will
  see in the UI are **Draft**, **Active**, **Pending Review**, **Archived**, and
  **Retired**. New articles start as Draft; publishing makes them Active.
- **Visibility** - Who can see the article: **Public**, **Organization**,
  **Project**, or **Private**. Public and Organization are visible to all org
  members; Private is visible only to the owner or creator; Project is visible
  to the owner, creator, or members of that project.
- **Freshness** - A computed signal based on when the article was last verified
  and when it expires. The detail page and cards show one of four states:
  **Verified recently**, **Content is stale**, **Expiring soon**, or **Needs
  verification**.
- **Verification** - A recorded review confirming an article is still accurate.
  Verifying resets the expiry date and raises the verification count.
- **Challenge** - A flag that an Active article may be wrong. Challenging moves
  it to Pending Review.
- **Tags** - Free-form labels on an article. Tags drive filtering, search tag
  expansion, and implicit graph edges. They are a search and filter facet: you
  add and remove tags as chips on the Search screen to widen or narrow results.
  Note: the editor shows a "Tags (comma-separated)" field, but tags typed there
  are not saved today (a known limitation; see Create and edit an article). Tags
  that appear on articles come from agent or API writes, not from the editor
  field.
- **Link** - A typed connection between two articles: **Related To**,
  **Supersedes**, **Depends On**, **Conflicts With**, or **See Also**. Links are
  read-only in the UI today (created through MCP tools or the API; see Links
  between articles).
- **Knowledge Graph** - The network of Beacons. Nodes are articles; edges are
  either explicit typed links or implicit "Tag Affinity" edges between articles
  that share enough tags.
- **Saved query** - A named, reusable search configuration you can reopen later.
  Scope can be Private, Project, or Organization.
- **Expiry policy** - Per-scope rules (System, Organization, Project) that set
  the minimum, maximum, and default number of days before an article expires,
  plus a grace period.

### Where to find it

Beacon lives at `/beacon/`. You must be logged in to BigBlueBam first; Beacon
has no login of its own and uses the shared platform session. If you are not
signed in, Beacon shows "Please log in to BigBlueBam first to access Beacon."
with a "Go to BigBlueBam Login" link to `/b3/`.

The left sidebar has six navigation items: **Home** (`/`), **Browse**
(`/list`), **Search** (`/search`), **Graph** (`/graph`), **Dashboard**
(`/dashboard`), and **Beacon Settings** (`/settings`). At the top of the sidebar
is a project scope selector; it shows the active project name or **"All
Projects"** by default, and it filters most views to that scope.

What you can do depends on your role. Editing access works like this: a
SuperUser can edit any Beacon; an org Admin or Owner can edit any Beacon in the
org; a Member can edit only Beacons they own or created. Editing System-level
expiry policy requires SuperUser.

Press the `?` key (when your cursor is not in a text field) to open the in-app
help from any Beacon screen.

![Knowledge home](screenshots/light/01-knowledge-home.png)

## Feature reference

### Knowledge Home

The home screen is your starting point. Its heading is **"Knowledge Home"** with
the subtitle "Welcome to Beacon, your team's knowledge base."

To use Knowledge Home:

1. Open Beacon at `/beacon/` or click **Home** in the sidebar.
2. Read the three stat cards at the top: **"Total Beacons"**, **"At Risk (7d)"**,
   and **"Recently Updated"**. Clicking "Total Beacons" or "At Risk (7d)" takes
   you to Browse; clicking "Recently Updated" takes you to the Graph.
3. Use a quick-action card to jump into a task: **"Create a Beacon"**,
   **"Browse"**, **"Search"**, or **"Knowledge Graph"**.
4. Scroll to **"Recent Activity"** to see up to 8 recently touched articles;
   click one to open its detail page.

### Browse the article list

Browse lists the Beacons you can see, with filtering. The screen is titled
"Article list" in docs and rendered at `/list`.

To browse and filter:

1. Click **Browse** in the sidebar.
2. Type into the search input (placeholder **"Search beacons..."**) to filter by
   text.
3. Click a status chip to filter by lifecycle state: **All**, **Active**,
   **Pending Review**, **Draft**, or **Archived**.
4. Read the project indicator near the toolbar: it shows "Showing beacons for:
   <name>" when scoped to a project, or "Showing all org beacons" otherwise.
5. Click a card to open that article's detail page.
6. Click **"Load more"** at the bottom to fetch the next page of results.

To start a new article from here, click **"New Beacon"** (or, if the list is
empty, **"Create Beacon"** in the "No beacons yet. Create your first one." empty
state).

![Browse articles](screenshots/light/03-browse-list.png)

### Read an article (detail page)

The detail page shows one article in full, with its lifecycle actions and
metadata.

What you see:

- The title, a **StatusBadge**, a **LifecycleActions** row, presence chips, and
  an **"Edit"** button.
- The summary, the rendered Markdown body, and the Tags row.
- An **Attachments** panel and a **Comments** section.
- A right sidebar with **Status**, **Owner**, **Project** ("Organization-wide"
  if the article has no project), **Freshness**, **Expires** (a date), **Last
  Verified** ("Never" if it has never been verified), **Verifications** (a
  count), **Tags**, **Linked Beacons** (each links to its target), and
  **Version** (vN, with an expandable history). A **"View in Graph"** link opens
  the article in the Graph.

To open an article, click any card in Browse, Search, the Graph, or the Recent
Activity list, then read or act on it from the detail page.

![Article detail](screenshots/light/02-article-detail.png)

### Create and edit an article

The editor is reached at `/create` (from the "Create a Beacon" card on Home or
"New Beacon" in Browse) and at `/<idOrSlug>/edit` (the "Edit" button on a detail
page). The header reads **"Create Beacon"** or **"Edit Beacon"**.

The body field is a **Markdown** editor, labeled **"Body (Markdown)"**. You
write Markdown directly; there is no rich-text formatting toolbar. When you edit
an **existing** article the body is a **live collaborative editor**: anyone else
who opens the same article edits the body with you in real time, and you see
their cursors and changes as they type (the label reads "live co-editing").
While creating a brand-new article (before the first save) the body is a plain
text area, since there is no shared article to join yet.

To write a new article:

1. Open the editor with **"New Beacon"** or the **"Create a Beacon"** card.
2. Type a title in the title field (placeholder "Beacon title...").
3. Optionally add a **Summary** (up to 500 characters; a live "N characters
   remaining" counter shows your budget).
4. Write the article in **Body (Markdown)** (placeholder "Write your knowledge
   article in Markdown...").
5. Choose **Project (optional)** from the select. The default option is
   "Organization-wide (no project)". This selector is shown only when creating;
   when editing, the project is read-only.
6. Choose a **Visibility**: Public, Organization, Project, or Private. The
   editor defaults to Organization.
7. Click **"Save as Draft"** to keep it as a Draft, or **"Publish"** to create
   it and immediately make it Active. Both buttons are disabled until the title
   is non-empty.

Known limitation: the editor includes a **"Tags (comma-separated)"** field
(placeholder "e.g. onboarding, deployment, api"), but anything you type there is
currently not saved on either create or edit. Do not rely on the editor to set
tags. Tags on an article today come from agent or API writes
(`beacon_upsert_by_slug` and the tag write endpoints), and you filter by them
on the Search screen.

Editing an existing article works the same way, except the Project field is
read-only, the body is the live collaborative editor described above (your edits
sync to anyone editing alongside you), and saving bumps the article's version and
writes a version snapshot. If someone changed the article's title, summary, or
visibility since you opened it, the save is rejected with a "this article changed
since you opened it" notice so you do not silently overwrite their change; the
body itself merges live and is not subject to that conflict check.

There is no screenshot of the editor in this set.

### Lifecycle actions

Lifecycle actions live in the row under the title on the detail page. Which
buttons appear depends on the article's current status. Each button opens a
confirmation dialog titled "<Action> Beacon".

- **Draft** shows **Publish**. Publishing moves the article to Active and
  recomputes its expiry. Dialog text: "This will make the beacon visible to
  others based on its visibility setting."
- **Active** shows **Verify**, **Challenge**, and **Retire**.
  - **Verify** records a verification, resets expiry, and raises the
    verification count. Dialog text: "Confirm this beacon is still accurate and
    up to date."
  - **Challenge** moves the article to Pending Review. Dialog text: "Flag this
    beacon for review. It will move to Pending Review status."
  - **Retire** soft-deletes the article: status becomes Retired and it no longer
    appears in active listings. Dialog text: "Retire this beacon. It will no
    longer appear in active listings."
- **Pending Review** shows **Publish** and **Retire**.
- **Archived** shows **Restore** and **Retire**. **Restore** returns an Archived
  article to Active and resets its expiry. Dialog text: "Restore this beacon to
  Active status."

To run a lifecycle action:

1. Open the article's detail page.
2. Click the action button in the lifecycle row.
3. Read the confirmation dialog and click the matching button to confirm, or
   **Cancel** to back out.

Known limitation: a **Retired** article also shows a **Restore** button, but the
server only restores articles that are currently Archived. Retired is a terminal
state, so clicking **Restore** on a Retired article returns an error and the
status does not change. To bring a Retired article back, recreate or re-author
it rather than relying on Restore.

Known limitation: a **Pending Review** article shows a **Publish** button, but
the server only publishes articles that are currently Draft. Clicking
**Publish** on a Pending Review article returns an error ("Cannot publish a
beacon with status 'PendingReview'; must be Draft") and the status does not
change. To return a Pending Review article to Active, verify it instead, which
records a verification and resets its expiry.

### Search

Search runs a hybrid query across every Beacon you can access. The heading is
**"Search"** with the subtitle "Find knowledge across all accessible Beacons."

To search:

1. Click **Search** in the sidebar.
2. Type a natural-language query in the primary input (placeholder **"Search
   Beacons..."**).
3. Optionally narrow with the QueryBuilder controls:
   - **Project:** multi-select chips ("All accessible projects" by default; use
     **"Add"** to pick specific projects).
   - **Tags:** chips plus an "Add tag..." typeahead.
   - **"Advanced filters"** expander, which exposes:
     - **Status** checkboxes: Active, Pending Review, Archived, Draft, Retired.
     - **Freshness:** "Expiring within [N] days".
     - **Retrieval** checkboxes: **"Graph expansion"**, **"Tag neighbors"**,
       **"Keyword fallback"**.
     - **Visibility** select: "Default (your highest)", Public, Organization,
       Project, or Private.
4. Watch the footer's live "~N Beacons match" count update as you adjust
   filters.
5. Click a result card to open the article.

Each **ResultCard** shows the title, a StatusBadge, the summary, a highlighted
matching passage, clickable tag chips ("Add '<tag>' to filters"), match-source
badges (**"Semantic match"**, **"Tag expansion"**, **"Link traversal"**,
**"Keyword match"**), the freshness state, a verification count, the owner, and
up to two linked beacons with their link type.

Your search configuration is reflected in the URL, so you can copy the link and
share an exact search with a teammate.

![Hybrid search](screenshots/light/06-search-results.png)

### Saved queries

You can name and reuse a search configuration.

To save a query:

1. Build the search you want in Search.
2. Click **"Save query"** in the footer to open the "Save Search Query" dialog.
3. Enter a **Name** and pick a **Scope**: "Private (only me)", Project, or
   Organization.
4. Confirm to save.

To reuse a saved query, open the **"Saved queries"** dropdown at the top right of
the Search screen, then click a saved entry to load it. In the
**SavedQueriesPanel** you can click an entry to load it, or click its trash icon
to delete it.

### Knowledge Graph

The Graph visualizes how articles connect. The heading is **"Knowledge Graph"**.

When no article is focused, the Graph shows a Knowledge Home layout: a "Hub
Beacons" canvas of the most-connected articles on the left, and on the right an
**"At Risk"** list (expiring within 7 days) and a **"Recently Updated"** list.

When you focus an article, the Graph draws a force-directed canvas of that
article's neighbors, with a breadcrumb trail, node and edge counts, and an
**EdgeLegend** explaining the colors.

To explore the graph:

1. Click **Graph** in the sidebar, or click **"View in Graph"** on a detail
   page to start from a specific article.
2. With an article focused, set **Hops:** to 1, 2, or 3 to widen or narrow how
   many steps out the graph reaches.
3. Use the implicit-edges eye toggle ("Show/Hide implicit edges") to show or
   hide Tag Affinity edges.
4. Use the **"Filter by Status"** dropdown (Active, Pending Review, Draft,
   Archived) to dim non-matching nodes; "Filtered nodes are dimmed, not hidden."
   Click "Clear" to reset.
5. Click a node to open its **NodePopover**, which shows the title, status,
   summary, tags, freshness, verification count, and owner, plus actions
   **"View Beacon"** (open detail) and **"Explore from here"** (re-center the
   graph on that node).

![Knowledge graph](screenshots/light/04-graph-explorer.png)

### Tags

Tags label articles for filtering, search expansion, and implicit graph edges.
In the UI today, tags are a search and filter facet rather than something you
add or remove on an individual article.

To work with tags:

1. Open the **Search** screen and find the **Tags:** control in the QueryBuilder.
2. Type into the "Add tag..." typeahead and pick a tag to add it as a filter
   chip; click a chip's remove control to drop it from the filter.
3. On a **ResultCard**, click a tag chip ("Add '<tag>' to filters") to add that
   tag to your search.

These tag chips add and remove tags from your search filter only; they do not
change the tags stored on an article. The article detail page and graph node
popovers display an article's tags read-only. The editor's "Tags
(comma-separated)" field does not persist (see Create and edit an article), so
the tags you see on articles today are written by agents or the API, not from
the UI. Writing tags goes through the tag endpoints (or `beacon_tag_add` /
`beacon_tag_remove`): you may add 1 to 20 tags at a time, each 1 to 128
characters, and removing a tag that is not present returns an error. Article
tags also drive the implicit "Tag Affinity" edges in the Graph.

### Links between articles

Links create typed connections between two articles. The available types are
Related To, Supersedes, Depends On, Conflicts With, and See Also.

In the UI today, links are read-only: the detail page lists an article's
existing links under **Linked Beacons** (each row opens its target), and the
Graph draws them as typed edges. There is no human "create a link" or "remove a
link" control in the Beacon SPA. Links are created and removed through the MCP
tools `beacon_link_create` and `beacon_link_remove` (or the equivalent API), so
an agent or integration sets up the connections that you then read and navigate.

To follow an existing link:

1. Open the source article's detail page.
2. Under **Linked Beacons**, click a target to jump to it.
3. Open the **Graph** (or click **"View in Graph"**) to see the link as a typed
   edge in context.

Creating a duplicate link (same source, target, and type) is rejected at the
tool/API layer.

### Comments

Each article has a threaded discussion. The heading is **"Comments (n)"**.

To comment:

1. On the detail page, scroll to the Comments section.
2. Type into the box labeled "Add a comment. Markdown supported." Markdown is
   supported in comments.
3. Click **"Post Comment"**.
4. To reply, click **Reply** on a comment (threads nest up to 4 levels deep).
5. To remove your own comment, click **Delete**. The confirm reads "Delete this
   comment? Replies will also be removed." Admins, owners, and SuperUsers can
   delete others' comments.

### Attachments

You can attach files to an article. The heading is **"Attachments (n)"**.

To attach a file:

1. On the detail page, find the Attachments panel.
2. Drop a file on the drop zone ("Drop a file here or") or click **"Choose
   File"**. The limit is "Max 10 MB. Images, PDF, text, office docs."
3. Each attached file row shows a thumbnail or icon, the filename, the size, the
   uploader, and the time, with **Download** and **Delete** actions.
4. To remove an attachment, click **Delete** and confirm "Delete attachment
   '<name>'?". The uploader, or an admin, can delete an attachment.

Uploading requires edit access to the article.

### Fridge Cleanout (governance dashboard)

The Dashboard is a freshness and governance console. Its header is **"Fridge
Cleanout"** with the subtitle "Knowledge governance dashboard". It has four
tabs: **Overview**, **At-Risk**, **Archived**, and **Agent Activity**.

This dashboard is freshness-only. It does not show article-view counts or
search-pattern analytics; those metrics do not exist in Beacon. Everything here
is about keeping knowledge verified and cleaning out stale articles.

To use each tab:

- **Overview**: read four cards - **"Freshness Score"** (a percentage),
  **"At-Risk (7 days)"**, **"Archived Backlog"** (articles archived more than 30
  days), and **"Total Active"** - plus a "Freshness Breakdown" bar that reads "X
  of Y active beacons verified within 30 days".
- **At-Risk**: a table of articles expiring within 7 days (Title, Expires,
  Owner, Status, Actions). Click a row's **Verify** or **Challenge** button to
  act on one article. To act in bulk, tick the checkboxes and click **"Verify
  Selected (n)"**.
- **Archived**: articles archived for 30 or more days (Title, Archived Since,
  Owner, Actions). Each row offers **Restore** and **Retire**. Tick checkboxes
  and click **"Retire Selected (n)"** to retire several at once.
- **Agent Activity**: recent verification events, each reading "Verified by
  <owner> <time>" with the article's verification count (shown as v<count>) and
  current status.

![Freshness dashboard](screenshots/light/05-governance-dashboard.png)

### Expiry Policy Settings

Beacon Settings is where you set how long knowledge stays trusted. The header is
**"Expiry Policy Settings"** with the subtitle "Manage knowledge freshness
policies across the hierarchy".

To view and set policy:

1. Click **Beacon Settings** in the sidebar.
2. Read the **"Effective Policy (Your Context)"** card, which shows the resolved
   Min, Max, Default Expiry, and Grace Period that apply to you right now.
   Policies resolve in order: Project, then Organization, then System.
3. Edit a policy in the appropriate editor:
   - **System Policy** (SuperUser only).
   - **Organization Policy**.
   - **Project Policy** (pick a project first, then edit its per-project policy).
4. In an editor, set Min, Max, and Default expiry (in days) plus the Grace
   period. Client validation enforces min <= default <= max and keeps values
   within the parent scope's bounds.
5. Click **"Save Policy"**. Success or warning text appears; editors you lack
   permission to change show "Read-only - requires higher permissions to edit".

There is no screenshot of Beacon Settings in this set.

A few notes on freshness mechanics that policy controls:
- A daily expiry sweep moves Active articles to Pending Review when they expire,
  moves Pending Review articles to Archived after the grace period, and deletes
  very old Drafts.
- The lifecycle includes an internal "Expired" value, but the live sweep never
  sets it and the UI has no badge for it, so you will not see an "Expired" status
  on any article in normal use. The states you encounter are Draft, Active,
  Pending Review, Archived, and Retired.

### Working with AI agents

Agents drive Beacon through its MCP tools (30 of them). They can author and
update knowledge, run retrieval to ground answers, verify articles, and build or
query the graph and policy. Comments and attachments have no MCP tools, so
agents cannot post comments or upload files; those stay human-only.

Common agent flows and the Beacon-specific tools behind them:

- **Idempotent ingestion.** Agents write or refresh knowledge with
  `beacon_upsert_by_slug` (the `POST /entries/upsert` write plane). The tool is
  keyed on the article's slug and returns a `created` flag so the agent can tell
  an insert from an update. Re-running it with the same slug updates in place
  rather than creating duplicates. This is the recommended path for bulk or
  repeated imports; there is no human button for it. Because the editor's tag
  field does not persist, agent and API writes are how tags get set on articles.
- **Authoring and lifecycle.** Beyond upsert, agents have the full set:
  `beacon_create`, `beacon_update`, `beacon_get`, `beacon_list`,
  `beacon_publish`, `beacon_verify`, `beacon_challenge`, `beacon_retire`,
  `beacon_restore`, `beacon_versions`, and `beacon_version_get`. Each tool
  resolves an article by UUID, slug, or title.
- **Grounding and retrieval (RAG).** Agents pull knowledge with `beacon_search`
  or `beacon_search_context`. The context variant always turns on graph and tag
  expansion and pre-fetches linked articles, so an agent gets a richer slice of
  the graph in one call. `beacon_suggest` powers typeahead.
- **Automated verification.** `beacon_verify` accepts verification types
  `AgentAutomatic`, `AgentAssisted`, and `ScheduledReview`, plus an optional
  confidence score. Agent verifications show up under the dashboard's **Agent
  Activity** tab, so a human can review what the agent confirmed. The daily
  expiry sweep also enqueues Pending Review articles for an agent verification
  pass.
- **Graph and governance.** Agents can build and read the graph with
  `beacon_link_create`, `beacon_link_remove`, `beacon_graph_neighbors`,
  `beacon_graph_hubs`, and `beacon_graph_recent`, and read or set expiry policy
  with `beacon_policy_get`, `beacon_policy_set`, and `beacon_policy_resolve`.
  Treat policy as the four expiry and grace fields (min, max, default expiry
  days, grace period days). Link creation and removal are agent/API only; the
  Beacon SPA has no human link-management control.
- **Tags and saved queries.** `beacon_tags_list` reads tags in scope;
  `beacon_tag_add` and `beacon_tag_remove` write them. `beacon_query_save`,
  `beacon_query_list`, `beacon_query_get`, and `beacon_query_delete` manage
  saved searches.

**Platform agent rails.** Beacon's tools run inside the suite-wide agentic
platform, so the same guardrails apply here as everywhere:

- **Visibility preflight.** Before an agent cites a Beacon in a shared surface,
  it must confirm the asker can see it by calling `can_access` (entity type
  `beacon.entry`). Beacons are visibility-gated; refusal reasons include
  `beacon_private_not_owner` and `beacon_project_not_member`. Anything the asker
  cannot see is dropped from the agent's answer.
- **Cross-app retrieval.** `search_everything` fans out across the suite and
  includes Beacon results with normalized scoring, and `resolve_references`
  turns canonical mentions into Beacon links. Both honor the same visibility
  rules.
- **Identity, heartbeat, and audit.** Agent and service accounts are tagged with
  a `kind` and emit heartbeats (`agent_heartbeat`); their Beacon writes are
  attributed in the unified activity view alongside Bam, Bond, and Helpdesk
  events, so you can audit what an agent created, verified, or retired.
- **Approvals and policy.** High-impact agent work can be routed through the
  proposal queue (`proposal_create` / `proposal_list` / `proposal_decide`) for a
  human to approve. Per-agent kill switches and tool allowlists (the `beacon.*`
  prefix) gate which agents may touch Beacon at all, and subscribed Bolt events
  can be pushed to agent runners over signed outbound webhooks.

For the full tool catalog, see `docs/apps/beacon/mcp-tools.md`.

## Working together (live presence)

BigBlueBam treats collaboration as ambient, not as a scheduled meeting. When you open a knowledge page, a presence strip shows who else is reading or editing it, and you can ring a teammate into a huddle from the page. Voice and video here are the digital version of bumping into a colleague in the hallway or stopping by their desk: a quick question, a shared look at the same thing, then back to work. Your presence travels with you across the suite through the Bureau virtual office. The Introduction covers the full pervasive-presence model.

Beacon goes a step further than presence on the article body itself: the editor for an existing article is **real-time co-editing**. Two or more people can write the same Markdown body at once and see each other's cursors and edits live, the way you would in a shared document, so a team can draft or correct an article together instead of trading "who has it open" messages. The shared text merges automatically (it is a CRDT), so simultaneous edits do not clobber each other; only the article's metadata (title, summary, visibility) uses the last-writer-wins conflict notice.

## User Stories

### Story: Write and publish your first article

**Who:** A new team member who has knowledge to capture.
**Goal:** Get an article published and visible to the team.
**Before you start:** Be logged in to BigBlueBam and have create access (any
Member can create).

**Steps**

1. Open Beacon at `/beacon/`. On **Knowledge Home**, click the **"Create a
   Beacon"** card (or click **Browse** then **"New Beacon"**).
2. In the editor, type a clear title in the field (placeholder "Beacon
   title...").
3. Add a short **Summary** (up to 500 characters).
4. Write the article in **Body (Markdown)** using Markdown syntax.
5. Leave **Project (optional)** as "Organization-wide (no project)" or pick a
   project.
6. Choose a **Visibility**. The default is Organization. (The editor also shows a
   "Tags (comma-separated)" field, but tags typed there are not saved today, so
   skip it; have an agent or the API set tags instead.)
7. Click **"Publish"** to create and activate the article in one step. (To keep
   working on it privately first, click **"Save as Draft"**, then later open the
   article and click **Publish** in the lifecycle row.)

**Result:** The article is Active and visible according to its visibility
setting. It appears in Browse, Search, and the Graph, and it has an expiry date
computed from the effective policy.

**Related:** Lifecycle actions; Create and edit an article. An agent does the
same with `beacon_create` then `beacon_publish`, or in one idempotent call with
`beacon_upsert_by_slug`.

### Story: Find an answer by meaning

**Who:** Anyone looking for knowledge without knowing exact keywords.
**Goal:** Locate the right article using a natural-language question.
**Before you start:** Be logged in. Articles must already exist and be visible
to you.

**Steps**

1. Click **Search** in the sidebar.
2. Type your question in the primary input (placeholder "Search Beacons...").
3. If results are too broad, open **"Advanced filters"** and narrow by
   **Status**, **Tags**, **Project:**, or **Freshness**.
4. Watch the "~N Beacons match" count to confirm you have narrowed sensibly.
5. Read the match-source badges on each result ("Semantic match", "Tag
   expansion", "Link traversal", "Keyword match") to judge why it matched.
6. Click the best result to open the article.

**Result:** You land on the article's detail page with the relevant passage
highlighted.

**Related:** Saved queries; the agent equivalents are `beacon_search` and
`beacon_search_context`.

### Story: Save and reuse a search

**Who:** Anyone who runs the same lookup repeatedly.
**Goal:** Keep a search configuration to reopen later.
**Before you start:** Have a useful search built in Search.

**Steps**

1. In Search, configure your query and filters as you want them.
2. Click **"Save query"** in the footer.
3. In the "Save Search Query" dialog, enter a **Name** and pick a **Scope**:
   "Private (only me)", Project, or Organization.
4. Confirm to save.
5. Later, open the **"Saved queries"** dropdown at the top right and click your
   saved entry to load it.

**Result:** The saved query reloads its full configuration with one click.
Organization-scoped queries are reusable by teammates.

**Related:** Search. Agents use `beacon_query_save`, `beacon_query_list`,
`beacon_query_get`, and `beacon_query_delete`.

### Story: Link related articles

**Who:** A knowledge owner organizing related content.
**Goal:** Connect two articles with a typed relationship.
**Before you start:** Links are created through MCP tools or the API; there is no
link-creation control in the Beacon SPA, so this story runs through an agent or
integration with edit access to the source article.

**Steps**

1. An agent (or API caller) invokes `beacon_link_create` with the source
   article, the target article, and a link type: Related To, Supersedes, Depends
   On, Conflicts With, or See Also.
2. Open the source article's detail page and confirm the new link appears under
   **Linked Beacons**.
3. Open the **Graph** or click **"View in Graph"** to see the new edge in
   context.

**Result:** The two articles are connected. The edge shows in the Graph with its
type label, and readers can navigate between them from **Linked Beacons**.

**Related:** Knowledge Graph; Links between articles. Agents use
`beacon_link_create` and `beacon_link_remove`.

### Story: Explore how knowledge connects

**Who:** Someone trying to understand a topic and its dependencies.
**Goal:** Walk the graph outward from a starting article.
**Before you start:** Have at least a few linked or tagged articles.

**Steps**

1. Click **Graph** in the sidebar, or click **"View in Graph"** from an
   article's detail page.
2. If you started without a focal node, click a hub in **"Hub Beacons"** to
   focus it.
3. Set **Hops:** to 2 or 3 to widen the view.
4. Toggle the implicit-edges eye control to show or hide Tag Affinity edges.
5. Click a node to open its **NodePopover**, then click **"Explore from here"**
   to re-center on a neighbor, or **"View Beacon"** to open it.

**Result:** You see the network around your topic and can move through related
articles without losing your place.

**Related:** Link related articles. Agents use `beacon_graph_neighbors`,
`beacon_graph_hubs`, and `beacon_graph_recent`.

### Story: Challenge an article that looks wrong

**Who:** Any reader who spots an inaccuracy.
**Goal:** Flag an Active article so an owner reviews it.
**Before you start:** Be able to read the article (challenging needs read access
plus challenge permission).

**Steps**

1. Open the article's detail page (or find it in the dashboard's **At-Risk**
   tab).
2. Click **Challenge** in the lifecycle row, or **Challenge** on the At-Risk row.
3. Read the confirmation ("Flag this beacon for review. It will move to Pending
   Review status.") and confirm.

**Result:** The article moves to **Pending Review** and surfaces for an owner to
verify, update, or retire.

**Related:** Keep knowledge fresh; lifecycle actions. The agent tool is
`beacon_challenge`.

### Story: Keep knowledge fresh (governance sweep)

**Who:** A knowledge owner, admin, or governance lead.
**Goal:** Verify what is about to expire and clear out old archived articles.
**Before you start:** Have edit access to the articles you will act on.

**Steps**

1. Click **Dashboard** in the sidebar to open **Fridge Cleanout**.
2. On **Overview**, check the **"Freshness Score"** and **"At-Risk (7 days)"**
   cards.
3. Open the **At-Risk** tab. For an article that is still correct, click
   **Verify**; for one that is wrong, click **Challenge**. To verify several,
   tick their checkboxes and click **"Verify Selected (n)"**.
4. Open the **Archived** tab. For each old article, click **Restore** to bring
   it back to Active or **Retire** to remove it. To retire several, tick their
   checkboxes and click **"Retire Selected (n)"**.

**Result:** At-risk articles are verified (their expiry reset) and stale
archived articles are retired or restored. The Freshness Score improves.

**Related:** Expiry Policy Settings; lifecycle actions. Agents use
`beacon_verify` and `beacon_retire`; agent verifications appear under the
**Agent Activity** tab as "Verified by <owner>" rows with the verification count
(v<count>) and status.

### Story: Set the freshness policy for a team

**Who:** An org Admin, Owner, or SuperUser.
**Goal:** Control how long knowledge stays trusted before it needs
re-verification.
**Before you start:** Have policy-edit permission for the scope you want to
change (System policy requires SuperUser).

**Steps**

1. Click **Beacon Settings** in the sidebar.
2. Review the **"Effective Policy (Your Context)"** card to see what currently
   applies.
3. In the **Organization Policy** editor (or **Project Policy** after picking a
   project), set Min, Max, and Default expiry (in days) and the Grace period.
4. Confirm the values satisfy min <= default <= max and stay within the parent
   scope's bounds.
5. Click **"Save Policy"** and read the success or warning text.

**Result:** New and republished articles in that scope compute their expiry from
the updated policy, and the daily sweep enforces the grace period.

**Related:** Fridge Cleanout. Agents use `beacon_policy_get`,
`beacon_policy_set`, and `beacon_policy_resolve`.

### Story: Discuss and attach evidence to an article

**Who:** A reviewer or contributor adding context.
**Goal:** Leave a comment and attach supporting evidence.
**Before you start:** Be able to read the article; uploading needs edit access.

**Steps**

1. Open the article's detail page.
2. In the Comments section, type in the box labeled "Add a comment. Markdown
   supported." and click **"Post Comment"**. Use **Reply** to respond in a
   thread.
3. In the Attachments panel, drop a file or click **"Choose File"** (max 10 MB:
   images, PDF, text, office docs).
4. Confirm the file appears in the list, with **Download** and **Delete**
   actions.

**Result:** The discussion and evidence are recorded on the article for the next
reader or reviewer.

**Related:** Read an article. Comments and attachments have no MCP tools, so
this story is human-only.

### Story: Ingest knowledge as an agent (idempotent import)

**Who:** An AI agent or an integration importing knowledge.
**Goal:** Create or update articles repeatably without making duplicates.
**Before you start:** The agent runs through the MCP server with a service
account and the right permissions (the `beacon.*` tool prefix must be allowed by
its agent policy).

**Steps**

1. The agent calls `beacon_upsert_by_slug` with a stable `slug`, plus `title`,
   `body_markdown`, and any of `summary`, `visibility`, `project_id`,
   `metadata`, or `change_note`.
2. The tool returns `data`, a `created` flag, and an `idempotency_key`.
3. The agent reads the `created` flag: `true` means a new article was inserted,
   `false` means an existing one was updated in place.
4. On the next run with the same slug, the agent calls the tool again; the
   existing article is updated rather than duplicated.

**Result:** Knowledge stays in sync with the source system across repeated runs.
Each upsert emits an `entry.upserted` Bolt event carrying the `created` flag, so
automations can react to inserts and updates differently. The write is
attributed to the agent in the unified activity view for later audit.

**Related:** Working with AI agents. A human can review the result on the
article's detail page.

## Related

- **Bam** (`/b3/`) - Beacon shares Bam's login and pulls its project list from
  Bam. Sign in to Bam before using Beacon.
- **Bolt** (`/bolt/`) - Beacon publishes lifecycle events (source `beacon`):
  `entry.upserted`, `beacon.created`, `beacon.updated`, `beacon.published`,
  `beacon.verified`, `beacon.challenged`, `comment.created`,
  `attachment.uploaded`, and `beacon.expired` (emitted when an article is
  retired). Use Bolt to automate reactions to knowledge changes.
- **Cross-app search** - Beacon articles surface in the platform-wide
  `search_everything` and `resolve_references` retrieval, so other apps and
  agents can find and cite knowledge subject to the same visibility rules.
- `docs/apps/beacon/mcp-tools.md` - the full Beacon MCP tool reference.
- `docs/apps/beacon/guide.md` - the Beacon product guide.
