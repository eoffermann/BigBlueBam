# Seeding Smoke Test

A 14-URL click-through checklist for verifying that demo seed data is present and visible across all surfaces after running `seed-all.mjs`.

## Prerequisites

- Stack is running: `docker compose up -d`
- Seeds have been applied: `docker compose --profile seed run --rm seed`
- You are logged in as an admin or superuser on the seed org (default: Mage Inc)

## Checklist

Work through each URL. Mark the check as passed when you see the described content.

| # | Surface | URL | What to verify |
|---|---------|-----|----------------|
| 1 | Bam Board | `http://localhost/b3/` | At least 1 project visible in the sidebar. Board shows tasks in multiple phases. |
| 2 | Bam Tasks | `http://localhost/b3/tasks` | Task list returns 15+ rows. Filters by status/assignee work. |
| 3 | Beacon Knowledge | `http://localhost/beacon/` | Knowledge home shows 100+ entries across multiple statuses. |
| 4 | Beacon Detail | Click any Active entry | Entry detail page loads with body content, tags, and freshness indicator. |
| 5 | Bearing Goals | `http://localhost/bearing/` | Goal dashboard shows 4+ goals across at least one period. |
| 6 | Banter Channels | `http://localhost/banter/` | Channel sidebar shows 6+ channels. At least one has messages. |
| 7 | Helpdesk Tickets | `http://localhost/helpdesk/` | Ticket list shows 12+ tickets across various statuses. |
| 8 | Bond Pipeline | `http://localhost/bond/` | Pipeline board shows 3+ deals. Company list shows 3+ companies. |
| 9 | Bolt Automations | `http://localhost/bolt/` | Automation list shows 3+ rules. At least one is enabled. |
| 10 | Blast Campaigns | `http://localhost/blast/` | Campaign list shows 2+ campaigns. |
| 11 | Board Whiteboards | `http://localhost/board/` | Board list shows at least 1 whiteboard with elements. |
| 12 | Book Events | `http://localhost/book/` | Event calendar or list shows 2+ events. |
| 13 | Bench Dashboards | `http://localhost/bench/` | Dashboard list shows at least 1 dashboard with widgets. |
| 14 | Brief Documents | `http://localhost/brief/` | Document list shows 2+ documents. |

## Automated Verification

For a programmatic check of row counts (no browser needed):

```bash
DATABASE_URL=postgres://bigbluebam:your-password@localhost:5432/bigbluebam \
  node scripts/seed-verify.mjs
```

This asserts minimum row counts per table and exits non-zero on failure.

## Re-running Seeds

If any surface is empty, re-run the full seed orchestrator:

```bash
docker compose --profile seed run --rm seed
```

The orchestrator is idempotent. It will not duplicate existing rows. Check the
console output for any FAIL lines indicating a seeder that errored out, and
investigate the specific per-app seeder log for details.
