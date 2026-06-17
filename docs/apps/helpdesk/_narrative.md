# Helpdesk - Customer Support

Helpdesk is BigBlueBam's customer-facing support portal. Each organization gets its own portal at `/helpdesk/<org-slug>/` where end users register with their own email and password, file support tickets, and track each one as a threaded conversation. Customer sign-in is completely separate from the suite single sign-on that staff use, so a customer never needs a Bam account. Support agents work the same tickets from the agent surface and from Bam, where every ticket is mirrored to a project task.

## Key Features

- **Org-scoped portals** at `/helpdesk/<org-slug>/`, with optional per-project portals at `/helpdesk/<org-slug>/<project-slug>/`. Any org with a Helpdesk settings row is live.
- **Separate customer authentication** with self-registration, login, optional email verification, allowed-domain restrictions, and a per-org signup-disabled switch.
- **Ticket lifecycle** through five statuses (Open, In Progress, Waiting on Customer, Resolved, Closed) with Low, Medium, High, and agent-only Critical priorities and optional categories.
- **Threaded conversations** with customer replies, agent replies, internal agent notes hidden from customers, inline images, and owner-scoped file attachments.
- **Duplicate handling**, both a customer-side annotative "mark as duplicate" and a true agent-side merge that moves messages onto the primary and closes the source.
- **Ticket to task mirroring**: every ticket spawns a Bam task in the portal's default project, and closures move that task to a terminal state.
- **Agent queue and settings** over REST and MCP, including SLA badges, similar-ticket search, and per-org configuration of default project, categories, welcome message, and verification.
- **Browser notifications** and **offline support** for reliable ticket tracking from the customer portal.

## Integrations

Helpdesk tickets become Bam tasks in the default project, so internal teams triage and assign support work alongside other project work. Agents authenticate on the agent surface with a per-agent agent API key (prefixed `hdag_`), distinct from the suite single sign-on. Customers and agents can share a ticket into a Banter channel for internal discussion. Bolt automations react to ticket lifecycle events (created, message posted, status changed, closed, reopened, user upserted, and SLA breached). Helpdesk also feeds the cross-suite unified activity view, and its MCP tools let agents triage, search, find similar tickets, upsert users, and read or edit settings. The actual knowledge base product is the separate Beacon app; Helpdesk has none of its own.

## Getting Started

Customers go to their organization's portal (for example `/helpdesk/your-org/`), create an account or sign in, then click **New Ticket** to file an issue with a subject, priority, optional category, and a rich-text description. They follow the ticket on **My Tickets** and reply in its conversation. Agents pick up incoming tickets from the agent queue or from Bam's ticket views, reply or add internal notes, and move the ticket through its statuses to Resolved or Closed. Admins configure each portal's default project, categories, welcome message, and verification settings before going live.
