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
| 0072 | `0072_bolt_rename_prefixed_events.sql` | Cross-Product | Wave 0.4 | **merged** (commit `9c6dc0d`) |
| 0075 | `0075_enable_rls_core_tables.sql` | Platform | Wave 1.A | **merged** (commit `cd38a46` + `3bb99f0` self-start fix; also self-starts `tasks.org_id` so 0075 no longer depends on 0078 filename ordering) |
| 0076 | (reserved, do NOT ship) activity_log partition shadow | Platform §3.4 | deferred per Platform Plan §3.4 until `activity_log` crosses 500k rows | unclaimed |
| 0077 | `0077_api_key_rotation.sql` | Platform | Wave 1.A | **merged** (commit `79565a6`) |
| 0078 | `0078_reconcile_bam_bearing_drift.sql` | Platform | Wave 0.1 second follow-up | **merged** (commit `a8fb19a`) |

## Overflow pool (0079+)

Unassigned. If a plan discovers it needs an additional migration number, claim the next sequential slot here and append a row.

| Number | Claimed by | Purpose |
|---|---|---|
| _(none yet)_ | | |
