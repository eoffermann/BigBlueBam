# Future Work

What's genuinely unfinished on `main`. Updated: 2026-04-04.

Both audits are fully closed:
- **Helpdesk↔Bam:** 53/57 resolved, 3 partial, 1 deferred, **0 open**
- **Permissions:** 81/82 resolved, 1 partial (documented tradeoff), **0 open**

Phase 6 & 7 roadmap items now landed on main:
- Burndown / velocity / CFD charts (SVG, `/projects/:id/reports`)
- GitHub integration (HMAC webhook, task-ref commit/PR linking, PR phase transitions)
- Slack integration (outbound notifications + slash commands)
- Accessibility audit pass (aria-labels on icon buttons, skip link, focus management)
- Board column virtualization (gated at 50+ tasks, dnd-kit safe)
- Redis caching layer (org settings 60s, user project listings 30s)

---

## Smaller items flagged during recent work

### Integration tests for helpdesk agent auth
`apps/helpdesk-api/test/security.test.ts` has 13 passing unit tests + **7 `it.todo` placeholders** for end-to-end flows that need a real DB fixture (ticket creation, ownership enforcement, internal-note visibility). Would close those out. ~1 day.

### helpdesk_login_history table
Bam gained a `login_history` table tracking successful+failed login attempts per user. Helpdesk customer logins are NOT recorded because the FK points at `users`, not `helpdesk_users`. A parallel `helpdesk_login_history` table would close that gap. ~2 hours.

### Agent-side HB-50 mirror edge cases
The ticket→task comment mirror fires on customer messages + customer close AND agent messages + agent close. Still NOT mirrored:
- Agent edits their own message
- Agent-initiated reopen (the task's terminal-phase flip on close has no paired "reopened" task-side note)

### Worker trim job for helpdesk_ticket_events
`helpdesk_ticket_events` table is append-only with no TTL. A worker job to trim entries older than N days is documented as debt in the migration. ~3 hours.

### Worker SMTP env naming (known)
Worker's `env.ts` expects `SMTP_PASS` now — sanity-check that an end-to-end delivery test passes when SMTP is configured against a real relay.

### Board performance with many tasks
Mage test data has ~200 tasks and board render is fine. Larger projects (500-2000 tasks) haven't been stress-tested. Ties into Phase 7 virtualization.

---

## Intentionally deferred (non-goals for this generation)

- **Teams / groups** — users assigned to projects individually; no team abstraction
- **SSO / SCIM provisioning** — username+password only
- **2FA / TOTP** — scaffolded on login schema (`totp_code?`) but no enrollment/verify endpoints
- **Permission templates** — roles are fixed enums (owner/admin/member/viewer/guest); no per-permission toggles
- **Helpdesk customers management screen** — helpdesk_users is a parallel identity pool, not yet surfaced in the People UI
- **HB-5** — no `org_id` on `helpdesk_users` (single global customer pool); multi-tenant partitioning of the customer side is a design decision

---

## Recently flagged cosmetic items

### site/ lives in its own private git repo
The marketing site source lives under `site/` (gitignored here — it has its own private repo because the public repo's audience doesn't need the website sources). Auto-detected by `scripts/deploy.sh` / `scripts/deploy.ps1`: when the directory is present, the overlay serves it at the root domain.

### MCP tools path verification
The `agent.routes.ts` helpdesk paths moved behind `/helpdesk/agents` during HB-7 work. Verify no MCP tool or integration doc hardcoded the old path. ~15 min grep + fix.
