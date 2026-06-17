# Beacon - Knowledge Base

Beacon is BigBlueBam's knowledge base app for writing, searching, linking, and
keeping team knowledge current. Every article is a "Beacon" with its own
lifecycle, freshness signal, and expiry date, so the library does not quietly
rot as facts change. Beacon is currently in BETA.

## Key Features

- **Articles with a lifecycle** - Write knowledge in a Markdown editor. Each
  article moves through Draft, Active, Pending Review, Archived, and Retired, and
  carries a version history with a snapshot on every edit.
- **Freshness and verification** - Every article has an expiry date and a
  freshness signal (Verified recently, Content is stale, Expiring soon, Needs
  verification). Verifying an article resets its expiry and raises its
  verification count; challenging it flags it for review.
- **Hybrid search** - Find knowledge by meaning, not just keywords. Search
  blends semantic vector retrieval (Qdrant) with tag expansion, link traversal,
  and a keyword fallback, and labels each result with the source that matched.
  Searches can be named and reused as saved queries.
- **Knowledge Graph** - Explore how articles connect through typed links
  (Related To, Supersedes, Depends On, Conflicts With, See Also) and implicit
  Tag Affinity edges. Walk neighbors out to three hops, inspect hubs, and see
  what changed recently.
- **Fridge Cleanout governance dashboard** - A freshness-focused console with
  Overview, At-Risk, Archived, and Agent Activity tabs for verifying what is
  about to expire and retiring stale articles in bulk.
- **Expiry policies** - Set how long knowledge stays trusted per System,
  Organization, and Project scope (min, max, and default expiry days plus a
  grace period), resolved hierarchically.

## Integrations

Beacon shares the platform login and pulls its project list from Bam. It
publishes lifecycle events to Bolt (source `beacon`: created, updated,
published, verified, challenged, the upsert event, comment and attachment
events, and the retire event) so automations can react when knowledge changes.

Beacon is fully agent-operable through the MCP server. Its 30 tools let agents
create, update, publish, verify, challenge, and retire articles; run grounding
retrieval (`beacon_search`, `beacon_search_context`); idempotently ingest
knowledge by slug (`beacon_upsert_by_slug`); and build or query the graph and
policy. Beacon plugs into the suite-wide agentic platform: agents are tracked by
identity and heartbeat, their writes appear in the unified activity view,
cross-app `search_everything` and mention resolution surface Beacon articles,
agent policies (the `beacon.*` allowlist) and signed outbound webhooks gate and
notify agent runners, and a `can_access` visibility preflight keeps agents from
citing articles a reader is not allowed to see.

## Getting Started

Sign in to BigBlueBam, then open Beacon at `/beacon/`. From Knowledge Home,
click **Create a Beacon** to write your first article in Markdown, then
**Publish** it to make it Active. Use **Search** to find knowledge by meaning,
**Graph** to explore connections, and **Dashboard** (Fridge Cleanout) to keep
the library verified. Org admins set freshness rules under **Beacon Settings**.
