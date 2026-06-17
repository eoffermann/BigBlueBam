# Bond - CRM

Bond is BigBlueBam's customer relationship management app for tracking contacts, companies, deals, and sales pipeline activity. Work your deals on a drag-and-drop pipeline board, keep a running activity timeline on every contact and company, score leads with your own rules, and read forecast, velocity, and win/loss numbers on the Analytics page. The board auto-selects your default pipeline the moment it loads, so you land on live deals instead of an empty picker.

## Key Features

- **Pipeline Board** with drag-and-drop deal cards across configurable pipeline stages, swimlane grouping by owner or close month, and a default pipeline that loads automatically.
- **Contact and Company Management** with detailed profiles, lifecycle stages, lead scores, activity timelines, and soft-delete with restore.
- **Deal Tracking** with value, probability, expected close date, a computed weighted value, Won/Lost outcomes, and per-stage rotting (stale-deal) detection.
- **Analytics** with total and weighted pipeline, win rate, conversion rates, deal velocity, revenue forecast buckets, and top loss reasons and competitors.
- **Custom Fields** defined per entity type (Contact, Company, or Deal) and applied org-wide, plus **org-wide lead scoring rules** that add or subtract points to compute each contact's score.
- **Duplicate and Stale Deal Detection** that ranks likely-duplicate contacts by confidence and flags deals stuck in a stage beyond their configured threshold.
- **AI agent surface** of over 70 MCP tools covering contact/company/deal CRUD, stage moves, Won/Lost, activity logging, idempotent upsert, dedupe, pipeline and stage admin, custom-field and scoring-rule admin, and the full analytics set.

## Integrations

Bond contacts feed Blast email campaign segments. Deal events (`deal.created`, `deal.stage_changed`, `deal.won`, `deal.lost`, `deal.rotting`, `contact.created`, `contact.upserted`, `activity.logged`) flow to Bolt on the `bond` source, so automation rules can react when a deal closes or rots. A deal's Related panel surfaces linked Bill invoices, Book events, and Bam tasks. Bench dashboards can query Bond data for sales reporting. Across the suite, agents reach Bond through the platform read plane (`search_everything`, `account_view`), run under an identity with heartbeat and `agent_policies` gating, route risky changes through the proposal queue, and preflight visibility with `can_access` before citing Bond records.

## Getting Started

Open Bond from the Launchpad. You start on the Pipeline Board, which loads your default pipeline automatically. If your org has no pipeline yet, open **Bond Settings** and create one; it seeds six default stages (Prospect, Qualified, Proposal, Negotiation, Closed Won, Closed Lost). Add contacts and companies from their lists, then add deals from the board and drag them between stages as they progress. Mark a deal Won or Lost on its detail page, log activities to build a timeline, and use the Analytics page to track pipeline health, forecast, and deal velocity.
