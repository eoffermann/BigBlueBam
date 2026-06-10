# Permissions system — sharp edges and deferred work

Living notes for the Wave E permission matrix rollout. Add to this file
whenever a permission-system landmine is discovered but deliberately not
fixed in the same pass.

## Before flipping enforcement on: grant members `bam.org_member.list`

**Recorded:** 2026-06-10 (Banter DM-roster incident)

The permission matrix has no entry granting plain members
`bam.org_member.list` (list the people in your own org), so the resolver
answers "deny by default" for the member role. Today this is harmless:
the gate on `GET /org/members` is `shadowOnly`, which only logs
would-deny telemetry and never blocks (fixed in `8699b74` — it *was*
accidentally blocking before that).

**The landmine:** the day the matrix is switched from shadow/telemetry
mode to real enforcement, every non-admin user loses `GET /org/members`,
and the Banter DM start-a-conversation roster (plus anything else that
lists org members for regular users) goes empty again — the exact
symptom of the 2026-06-10 incident. Decide before the flip: either grant
member-tier `bam.org_member.list`, or give guests/members a scoped
people-listing endpoint. The would-deny warnings are visible in api logs
(`shadowOnly: resolver would deny`) and can be used to find any other
permission with the same gap before enforcement day.

## Satellite apps have no shadow telemetry

`shadowOnly` now uses `canResolve` (the non-blocking decision probe).
The satellite HTTP permissions plugin (`httpPermissionsPlugin` in
`packages/permissions/src/index.ts`) stubs `canResolve` to always-true,
so bearing/bench/book shadow gates currently produce no would-deny
telemetry at all. Before enforcement day, give the HTTP plugin a real
probe (POST to the dual-read endpoint without replying) so satellite
would-deny data exists too.
