# BigBlueBam - One suite, sixteen apps, built for people and agents together

## Overview

Most teams do not run one tool. They run a project tracker, a chat app, a CRM, a
help desk, a docs editor, a whiteboard, a scheduler, an invoicing tool, and a
handful of others, and then they spend their day moving information between all of
them by hand. A deal closes in one app and nobody tells the project app. A
decision gets made in chat and never reaches the doc. The "AI feature" each vendor
added last year is a chat box in the corner that can summarize a page but cannot
actually do anything.

BigBlueBam is the answer to that sprawl: sixteen applications that behave like one
product. They share a single login, a single organization and user model, and a
single set of permissions. A deal in the CRM can become a project. A sticky note
on the whiteboard can become a task. A won deal can become an invoice. You do not
re-key anything, and you do not lose the thread when work moves from one app to
the next.

Three ideas run through the whole suite:

- **It is one system, built recently, on one stack.** Not a decade of acquired
  products stitched together with webhooks. Because the apps share a data model,
  the connections between them are real, not bolted on.
- **Agents are first-class, not a sidebar.** Nearly every action a person can take
  in BigBlueBam is also available as an MCP tool, so an AI agent can do real work
  on the same boards, with the same permissions and the same audit trail as a
  person. The suite ships more than 730 of these tools. This is the architecture,
  not an add-on.
- **Presence is pervasive.** Every place you work is a live, shared surface. You
  can see which teammates are on the same task, deal, document, diagram, or board,
  pull them into a voice or video huddle with a tap, and co-edit in real time.
  Voice and video are ambient here, the digital equivalent of bumping into someone
  in the hallway, not a scheduled meeting.

BigBlueBam is open source and self-hostable. You can read it, run it on your own
hardware, and export your data with plain SQL. It is built for small-to-medium
teams (2 to 50 people), and it scales out by running more copies of any stateless
service.

### Key concepts

A few ideas explain how the whole suite hangs together.

- **One organization, shared everywhere.** You sign in once. Your organization,
  your teammates, and your roles are the same in every app. Switching from the
  project board to the CRM to the help desk does not mean switching accounts.
- **One permission model.** Roles (owner, admin, member, viewer, guest) and
  per-action permissions apply consistently across the apps, so who-can-see-what
  is decided in one place, not re-invented per tool.
- **The apps cross-reference each other.** A help desk ticket can spawn a project
  task. A document can link to a knowledge-base article. A booking can create a
  CRM contact. These links are first-class, so each side can show the other.
- **Events connect the apps.** When something happens in one app (a task changes
  state, a deal goes stale, a form is submitted), it can emit an event that an
  automation in Bolt picks up to do the next thing, with no glue code.
- **Agents work the same surfaces you do.** An agent authenticates like a user,
  is bound by the same permissions, and every action it takes is recorded. It is
  not a separate, weaker API. It is the same product.
- **The apps are live, not solo.** Presence, real-time co-editing, and one-tap
  voice and video are woven through the suite, so working together does not mean
  scheduling a meeting. A virtual office (Bureau) carries your presence across
  every app, and an agent can be pulled into a call too.
- **Yours to run.** The software is open source. Run the whole stack with one
  command, point it at managed databases if you like, and your data stays in a
  Postgres database you can query directly.

### Where to find it

Everything lives under one domain. Each app has its own path, and a Launchpad and
a command palette move you between them.

- The **Launchpad** lists every app available to your organization and is the
  fastest way to jump between them.
- The **command palette** (press Cmd+K or Ctrl+K in any app) searches and
  navigates without the mouse.
- Each app is served at its own path: the project app at `/b3/`, chat at
  `/banter/`, the CRM at `/bond/`, the help desk at `/helpdesk/`, and so on. A
  full path map is in the project README.
- The **"(?)" Help Center** in each app's top bar opens the same documentation you
  are reading now, per app, with search and cross-references.

## The sixteen apps

Here is the whole suite at a glance, grouped by what you are trying to do. Each
app is deep enough to stand on its own and is genuinely better because it lives
next to the others. The tool counts are the number of MCP actions an agent can
take in that app.

### Plan and build the work

- **Bam (123 tools), project management.** Sprint-powered Kanban boards with
  configurable phases, swimlanes, carry-forward sprints, and Board, List,
  Timeline, Calendar, and Workload views. The hub the other apps feed work into.
- **Board (40 tools), visual collaboration.** An infinite canvas for real-time
  brainstorming, with sticky notes that can be promoted straight into Bam tasks.
- **Brief (48 tools), collaborative documents.** Real-time documents that can
  graduate into the knowledge base when they are ready to be canonical.
- **Beacon (38 tools), knowledge base.** Hybrid search, a knowledge graph, and
  built-in freshness governance so the answers stay honest instead of rotting.
- **Blueprint (36 tools), structured diagrams.** Diagrams that are data, not
  drawings: every node and edge is a real object you and your agents can read,
  edit, version, and turn into tasks.
- **Bearing (30 tools), goals and OKRs.** Set objectives and key results, track
  progress, and catch the goals slipping behind before the period closes.

### Communicate and coordinate

- **Banter (69 tools), team chat.** Real-time channels and DMs where your
  conversations and your AI agents work in the same room.
- **Bureau (37 tools), virtual office.** Live floors and rooms with a presence
  widget that follows you across the suite, so a remote team has a place to be.
- **Book (25 tools), scheduling.** Team calendars, availability, and public
  booking links, with bookings that can flow into the CRM.

### Grow the business

- **Bond (69 tools), CRM.** A lightweight CRM with visual pipelines, stale-deal
  detection, and a full agent surface. Deals can become projects and invoices.
- **Blast (28 tools), email campaigns.** Turn Bond contacts into campaigns with a
  visual builder, saved segments, and open and click analytics.
- **Helpdesk (11 tools), support portal.** A branded support portal per
  organization, where customer tickets resolve on the project board.

### Run operations

- **Bill (47 tools), invoicing.** Turn client work into billed, tracked, and
  reconciled revenue, with PDFs and recurring billing.
- **Bench (32 tools), analytics.** Shared dashboards, ad-hoc queries, and
  scheduled reports built from the data the rest of the suite already creates.
- **Blank (20 tools), forms.** Build forms and surveys in a visual editor, publish
  them to a public link, and collect responses.
- **Bolt (24 tools), automation.** Event-driven workflows that connect every app:
  when this happens, if these conditions hold, then run these steps.

## How the apps work together

The suite earns its name when work crosses app boundaries without anyone copying
and pasting. A few of the connections that ship today:

- **From lead to delivery to paid.** A Bond deal can be promoted into a Bam
  project, the delivered work can be turned into a Bill invoice from tracked time,
  and a public Book booking can create the Bond contact in the first place.
- **From conversation to work.** A Banter message can be shared as a task or a
  ticket, and a task can be deep-linked back into a channel by its human-readable
  id. A Board sticky or a Blueprint node can be promoted into Bam tasks.
- **From support to fix.** A Helpdesk ticket can spawn a Bam task, and the task
  then shows a Helpdesk tab linking the two, so the engineer and the support agent
  see the same thread.
- **From knowledge to reuse.** A Brief document can be promoted into a Beacon
  knowledge article, and documents and articles can link to the tasks and entities
  they describe.
- **One notification surface and one activity stream.** Mentions, assignments, and
  cross-app events land in a shared feed and a unified activity view, so you do not
  watch sixteen inboxes.
- **Automation as the connective tissue.** Bolt listens for events from any app
  (a deal goes stale, a form is submitted, a task is assigned) and runs the next
  step, so the integrations above can be extended without writing glue code.

## Pervasive presence: the apps are live, shared spaces

BigBlueBam is built for teams that work together all day, whether they share a
room or are spread across the world. The apps are not solo tools you each use in
your own tab. They are live, shared surfaces. Open a task, a deal, a document, a
diagram, a ticket, or a board and you can see who else is there with you, right on
the page.

That presence is the doorway to working together in the moment:

- **See who is here.** A presence strip on the work surfaces (tasks in Bam, deals
  in Bond, documents in Brief, diagrams in Blueprint, tickets in Helpdesk,
  knowledge in Beacon, and the Board canvas) shows the teammates looking at the
  same thing you are.
- **Pull someone in with a tap.** From that strip you can ring a teammate into a
  voice or video huddle on the spot. It is a tap, not a calendar invite.
- **Work in the same place.** Documents in Brief, the canvas in Board, and
  diagrams in Blueprint are co-edited live, with each other's cursors and changes
  appearing as they happen. Banter carries real-time channels, DMs, and calls or
  huddles in the same room as the conversation.
- **A place to be.** Bureau is the always-on virtual office: live floors and
  rooms, with a presence widget that follows you across every app, so a teammate
  deep in the CRM is still findable and reachable.
- **Bring an agent into the room.** Presence and calls are not limited to people.
  An AI agent can be invited into a Banter call to listen and help.

The mental model is a hallway, not a meeting. Voice and video here are not a
scheduled call or a formal meeting; they are what happens when you bump into a
colleague in the hall or wander over to their desk. A quick question, a shared
screen, two people looking at the same thing for a minute, then back to work.
Geography stops mattering: the team is together even when it is apart.

## Working with AI agents

BigBlueBam treats an AI agent as a teammate that uses the product, not as a
chatbot pasted onto it.

- **Parity, not a sidebar.** Nearly every action a person can take is also an MCP
  tool. The suite exposes more than 730 of them across the sixteen apps and a
  shared platform layer (identity, search, activity, approvals, and more). An
  agent can plan a sprint, move a deal, triage a ticket, draft a campaign, or run
  a report.
- **Same permissions, same audit trail.** An agent authenticates like any user and
  is bound by the same roles and per-action permissions. Every action it takes is
  recorded, and destructive actions require an explicit two-step confirmation.
- **Bring your own agent.** The platform gives an agent the same access a person
  has. Running the agent is up to you. Agent operation is a capability the suite
  enables, not a turnkey service that the install deploys for you.

## Open source and self-hosting

The software is open source. You can read it, run it, host it, and export from it.

- **One command to run the whole stack.** The entire suite comes up with Docker
  Compose. Data services (Postgres, Redis, object storage, vector search) can be
  swapped for managed cloud equivalents by changing environment variables only.
- **Your data is yours.** Everything lives in a Postgres database you can query.
  There is no proprietary export wall and no "contact sales to get your data out."
- **Scales by copies.** The application services are stateless, so you scale by
  running more of them. A team of one can run it from a single board; a team of
  fifty can run dozens of projects side by side.

## User Stories

These walk through scenarios that cross several apps, which is where the suite is
different from sixteen separate tools.

### Story: A lead becomes a project becomes an invoice

A prospect books a call through a public Book link. The booking creates a contact
in Bond, where it moves through the pipeline until the deal is won. The won deal is
promoted into a Bam project, the team delivers the work and tracks time against
its tasks, and at the end of the month Bill turns that tracked time into an
invoice. No one re-typed the client's details at any step.

### Story: A support ticket becomes a fix

A customer files a ticket in your organization's Helpdesk portal. Support triages
it and spawns a Bam task for engineering. The task carries a Helpdesk tab that
links back to the ticket, so when the engineer closes the task, support can see it
and reply to the customer. The whole thread stays connected.

### Story: An idea becomes shipped work

The team sketches a feature on a Board canvas, turns the sticky notes into Bam
tasks, and writes the spec in a Brief document that links to those tasks. When the
spec stabilizes, it is promoted into Beacon so the next person who asks "how does
this work" finds the canonical answer instead of re-deriving it.

### Story: An agent works alongside the team

An AI agent assigned to the project watches for tickets, drafts replies, and files
tasks, all through the same MCP tools and under the same permissions a human
teammate has. Its actions show up in the activity stream next to everyone else's,
and anything destructive waits for a person to confirm.

### Story: A hallway moment, on demand

You open a task in Bam and notice from the presence strip that a teammate is
already looking at it. Instead of typing a paragraph, you ring them into a huddle
straight from the card, talk it through for two minutes while you both look at the
same task, and get back to work. No meeting was scheduled, no link was pasted, and
nobody left the app they were in.

### Story: One place to stand

A distributed team keeps Bureau open as its virtual office. Presence follows each
person across every app, so a teammate deep in the CRM is still reachable, and a
quick question does not require scheduling a meeting. When a decision lands, it
becomes a task, a doc, or a ticket without leaving the suite.
