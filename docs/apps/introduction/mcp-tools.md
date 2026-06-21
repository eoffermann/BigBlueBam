# BigBlueBam MCP Tools (suite overview)

BigBlueBam is agent-first by design. Nearly every action a person can take in the
product is also exposed as an MCP tool, so an AI agent can do real work on the
same boards as your team, bound by the same roles and permissions and recorded in
the same audit trail. Destructive actions require a two-step confirmation. This is
not a chat sidebar bolted onto the product; it is the product, reachable by a tool
call.

The suite exposes more than 730 tools. They divide into per-app catalogs and a
shared cross-cutting platform layer (identity and audit, cross-app search, the
unified activity stream, approval queues, visibility checks, entity links,
attachments, agent policies and webhooks, and more) that any agent can use across
apps.

| App | What an agent can do | Tools |
|-----|----------------------|-------|
| Bam | plan sprints, create and move tasks, run reports | 123 |
| Banter | post, reply, react, and manage channels | 69 |
| Bond | manage contacts, companies, deals, and pipelines | 69 |
| Brief | create and co-edit documents, manage versions | 48 |
| Bill | create invoices, record payments, run billing | 47 |
| Board | add and arrange canvas elements, promote to tasks | 40 |
| Beacon | create, search, link, and verify knowledge | 38 |
| Bureau | move through the virtual office, manage presence | 37 |
| Blueprint | read, edit, version, and lay out diagram graphs | 36 |
| Bench | build dashboards, run queries, schedule reports | 32 |
| Bearing | set goals and key results, track progress | 30 |
| Blast | draft campaigns, manage segments, read analytics | 28 |
| Book | manage calendars, availability, and bookings | 25 |
| Bolt | create, test, and run automations | 24 |
| Blank | build forms, read and export submissions | 20 |
| Helpdesk | search, reply to, and resolve tickets | 11 |

Counts are per-app catalog sizes; the shared platform layer adds the cross-cutting
tools on top. Each app's own `mcp-tools.md` lists its tools in full. Tool counts
drift as the catalogs grow; verify against each app's `meta.json` before quoting a
number.
