# BigBlueBam - The integrated suite

BigBlueBam is sixteen applications that behave like one product. Project
management, chat, a CRM, a help desk, documents, a whiteboard, knowledge,
scheduling, invoicing, analytics, forms, automation, goals, diagrams, email
campaigns, and a virtual office all share one login, one organization and user
model, and one set of permissions. Work moves between them without re-keying:
a deal becomes a project, a sticky note becomes a task, a won deal becomes an
invoice. It is built for small-to-medium teams, it is open source, and it is
designed so AI agents can do real work on the same surfaces as the people.

## Key Features

- **One organization across every app** - a single sign-in, the same teammates,
  and one role and permission model everywhere, so switching apps never means
  switching accounts
- **Sixteen genuinely deep apps** - each strong enough to stand alone (Bam for
  projects, Bond for CRM, Banter for chat, Beacon for knowledge, and a dozen
  more) and better for living next to the others
- **Real cross-app connections** - help desk tickets spawn project tasks,
  bookings create CRM contacts, documents graduate into the knowledge base, and
  won deals turn into invoices, because the apps share a data model
- **Pervasive presence and live collaboration** - every work surface shows who
  else is there, one tap rings a teammate into a voice or video huddle, documents
  and boards and diagrams are co-edited in real time, and the Bureau virtual
  office carries your presence across every app, so voice and video feel like a
  hallway run-in rather than a scheduled meeting
- **Agent parity, not a sidebar** - nearly every action a person can take is also
  an MCP tool (more than 730 across the suite), so an AI agent works the same
  boards with the same permissions and the same audit trail as a teammate
- **Event-driven automation** - Bolt listens for events from any app and runs the
  next step, so the integrations extend without glue code
- **Open source and self-hostable** - read it, run the whole stack with one
  command, host it on your own hardware, and export your data with plain SQL

## Integrations

The apps are the integration. A Bond deal promotes into a Bam project; tracked
time on that project becomes a Bill invoice; a public Book link creates the Bond
contact in the first place. A Banter message can be shared as a task or a ticket
and deep-linked back by its human id. A Board sticky or a Blueprint node can be
promoted into Bam tasks. A Brief document can graduate into a Beacon article.
Mentions and cross-app events land in one shared feed and a unified activity view,
and Bolt automations tie any of these together on a trigger. Outbound email
resolves through a two-level relay (a platform-wide SMTP relay with per-org
overrides), and a Launchpad plus a command palette (Cmd+K) move you across the
whole suite.

## Getting Started

Sign in once and open the Launchpad to see every app your organization has. Start
in Bam: create a project from a template so phases and states arrive seeded, add
a few tasks, and invite your team from the People page. From there, follow the
work where it goes: open Bond if you are tracking deals, Banter to talk, Beacon to
write down what the team learns. Press Cmd+K anywhere to jump between apps, and
open the "(?)" Help Center in any top bar for that app's documentation. If you are
running it yourself, the whole stack comes up with one Docker Compose command and
your data lives in a Postgres database you control.
