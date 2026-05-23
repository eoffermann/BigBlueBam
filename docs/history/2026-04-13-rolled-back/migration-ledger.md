# 2026-04-13 Migration Number Ledger

Authoritative registry of migration numbers reserved for the 2026-04-13 implementation push. Add new entries in the 0078+ range and update this file in the same PR that claims the number. Never reuse a number.

## Reserved ranges (pre-dispatch)

| Range | Plan | Purpose |
|---|---|---|
| 0047 - 0049 | Beacon | Per plan |
| 0050 - 0052 | Bearing | Per plan |
| 0053 - 0055 | Bench | Per plan |
| 0056 - 0057 | Bill | Per plan |
| 0058 | Blank | Likely unused |
| 0059 | Blast | Per plan |
| 0060 - 0061 | Board | Per plan |
| 0062 - 0064 | Bolt | Per plan |
| 0065 - 0066 | Bond | Per plan |
| 0067 - 0068 | Book | Per plan |
| 0069 - 0071 | Brief | Per plan |
| 0072 - 0074 | Cross-Product | `0072` = rename prefixed events (Wave 0 item 4); `0073-0074` reserved |
| 0075 - 0077 | Platform | `0075` = RLS core tables; `0076` = activity_log partition shadow (deferred, do NOT ship); `0077` = API key rotation |

## Claimed / assigned

| Number | File | Plan | Wave item | Status |
|---|---|---|---|---|
| 0072 | `0072_bolt_rename_prefixed_events.sql` | Cross-Product | Wave 0 item 4 | pending |
| 0075 | `0075_enable_rls_core_tables.sql` | Platform | Wave 1 item 1 | pending |
| 0077 | `0077_api_key_rotation.sql` | Platform | Wave 1 item 1 | pending |
| 0078 | `0078_reconcile_bam_bearing_drift.sql` | Platform | Wave 0.1 item 1 (PR #5 second follow-up) | in-review |

## Overflow pool (0079+)

Unassigned. If a plan discovers it needs an additional migration number, claim the next sequential slot here and append a row.

| Number | Claimed by | Purpose |
|---|---|---|
| _(none yet)_ | | |
