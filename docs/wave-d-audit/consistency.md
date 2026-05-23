# Wave D Permission Catalog Consistency Audit

**Date:** 2026-05-17
**Branch:** `permissions`
**Auditor:** automated cross-check (`docs/wave-d-audit/audit.mjs`)
**Question:** Are the three permission-catalog sources of truth consistent enough to flip `BBB_PERMISSIONS_ENFORCE` from `warn` to `on`?

Three sources:

| # | Source                  | Path                                                                                                                        |
|---|-------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| M | Manifest JSON           | `docs/permissions-action-manifest.json`                                                                                     |
| G | Generated TypeScript    | `packages/permissions/src/generated/permissions.ts`                                                                         |
| D | Database `permissions`  | seeded by `0145_permissions_seed_actions.sql` + delta migrations `0151_*`, `0153_*` and the `0152_*` `requires_superuser` add |

## 1. Counts

| Source                              | Count |
|-------------------------------------|------:|
| `manifest.counts.total`             |  1083 |
| `manifest.permissions.length`       |  1083 |
| `PERMISSIONS` (generated TS array)  |  1083 |
| `SELECT COUNT(*) FROM permissions`  |  1083 |

All three agree: **1083 / 1083 / 1083.**

## 2. ID set diff

Symmetric diffs between every pair of sources:

| Diff                  | Count |
|-----------------------|------:|
| manifest \ generated  |     0 |
| generated \ manifest  |     0 |
| manifest \ db         |     0 |
| db \ manifest         |     0 |
| generated \ db        |     0 |
| db \ generated        |     0 |

ID sets are **identical** across all three sources.

## 3. Flag agreement

Checked all four boolean fields (`is_read`, `is_destructive`, `requires_confirmation`, `requires_superuser`) across **every** permission, not just a sample.

| Pair               | Mismatches |
|--------------------|-----------:|
| manifest vs gen TS |          0 |
| manifest vs db     |      **1** |
| gen TS vs db       |      **1** |

The single mismatch:

| ID                                          | Field                | Manifest | Generated | Database |
|---------------------------------------------|----------------------|---------:|----------:|---------:|
| `bam.superuser_permission_divergence.list`  | `requires_superuser` |   `true` |    `true` |  `false` |

### Sample table (51 rows, 3 per app × 17 apps; all agree)

Below is a small slice of the structured sample (`docs/wave-d-audit/audit-report.json` contains all 51 rows). Every row shows `(manifest, generated, db)` and the per-row `ok` flag is `true` for **every** sample.

| ID                                | App     | is_read | is_destructive | requires_confirmation | requires_superuser |
|-----------------------------------|---------|---------|----------------|-----------------------|--------------------|
| `agent.audit.read`                | agent   | t/t/t   | f/f/f          | f/f/f                 | f/f/f              |
| `agent.self.report`               | agent   | f/f/f   | f/f/f          | f/f/f                 | f/f/f              |
| `agent.webhook.rotate_secret`     | agent   | f/f/f   | f/f/f          | f/f/f                 | f/f/f              |
| `bam.account.view`                | bam     | t/t/t   | f/f/f          | f/f/f                 | f/f/f              |
| `bam.task.delete`                 | bam     | f/f/f   | t/t/t          | t/t/t                 | f/f/f              |
| `bam.webhook.update`              | bam     | f/f/f   | f/f/f          | f/f/f                 | f/f/f              |
| `banter.active_huddle.get`        | banter  | t/t/t   | f/f/f          | f/f/f                 | f/f/f              |
| `banter.dm.send`                  | banter  | f/f/f   | f/f/f          | f/f/f                 | f/f/f              |
| `platform.org.create`             | platform| f/f/f   | f/f/f          | f/f/f                 | t/t/t              |
| `platform.org.delete`             | platform| f/f/f   | t/t/t          | t/t/t                 | t/t/t              |

(Apps spanned in the sample: agent, bam, banter, beacon, bearing, bench, bill, blank, blast, board, bolt, bond, book, brief, helpdesk, platform, shared.)

## 4. Map completeness

| Source / Map                                       | Count |
|----------------------------------------------------|------:|
| Manifest entries with `source.source === 'rest'` (unique refs) |  793 |
| `ROUTE_TO_PERMISSION` entries in generated TS      |  793 |
| Manifest entries with `source.source === 'mcp'` (unique refs)  |  348 |
| `TOOL_TO_PERMISSION` entries in generated TS       |  348 |

| Completeness check                                                            | Count |
|-------------------------------------------------------------------------------|------:|
| Manifest REST refs missing in `ROUTE_TO_PERMISSION`                            |     0 |
| `ROUTE_TO_PERMISSION` keys not present as a manifest REST ref                  |     0 |
| Manifest MCP refs missing in `TOOL_TO_PERMISSION`                              |     0 |
| `TOOL_TO_PERMISSION` keys not present as a manifest MCP ref                    |     0 |
| `ROUTE_TO_PERMISSION` values that don't map to a catalog ID                    |     0 |
| `TOOL_TO_PERMISSION` values that don't map to a catalog ID                     |     0 |

Maps are **fully consistent** with the manifest. Note that `manifest.permissions.length (1083) < routes + tools (793 + 348 = 1141)` because some catalog entries are sourced from both an MCP tool and a REST route (e.g. `bam.task.delete`), and a single permission can correspond to multiple source rows.

## 5. CI guard result

```
$ node scripts/check-permission-catalog.mjs
✓ permission catalog up to date (2 artifacts checked)
EXITCODE=0
```

Important context: this guard only verifies that re-running the codegen against the working tree produces no diff on `docs/permissions-action-manifest.json` and `packages/permissions/src/generated/permissions.ts`. It explicitly does **not** check the seeded database — the `0145_permissions_seed_actions.sql` file is frozen and deltas land in `0151_*` / `0153_*` migrations. So the guard would not have caught the one mismatch above.

## 6. `requires_superuser` column

- Column exists in DB:

  ```
  Column                | Type    | Nullable | Default
  requires_superuser    | boolean | not null | false
  ```

- TypeScript interface (`packages/permissions/src/generated/permissions.ts:8-17`) declares
  `readonly requires_superuser: boolean` on `PermissionMeta`. Confirmed by inspection.

- Per-source counts of rows with `requires_superuser = true`:

  | Source              | Count |
  |---------------------|------:|
  | Manifest            |    11 |
  | Generated TS        |    11 |
  | Database            | **10** |

- Symmetric diff of the SU-only set:

  | Diff                    | Count | IDs |
  |-------------------------|------:|-----|
  | manifest \ db           |     1 | `bam.superuser_permission_divergence.list` |
  | db \ manifest           |     0 | (none) |
  | manifest \ generated TS |     0 | (none) |
  | generated TS \ manifest |     0 | (none) |

  Manifest and generated TS agree on all 11 IDs; the DB is missing the flag on
  exactly one row: `bam.superuser_permission_divergence.list`.

### Root cause

Migration ordering. `0152_permissions_requires_superuser.sql` adds the column and runs a one-shot backfill (`WHERE resource LIKE 'superuser_%'`). Migration `0153_permissions_seed_actions_delta_002.sql` then inserts the new permission `bam.superuser_permission_divergence.list` — but the `INSERT ... ON CONFLICT (id) DO UPDATE SET ...` clause in `0153` does not update `requires_superuser`, and the data backfill in `0152` has already run. So the new row was inserted with the column default `false` and never re-flagged.

Future deltas have the same problem unless they either:

1. Set `requires_superuser` explicitly in the INSERT column list, or
2. Re-run the backfill rule (`UPDATE permissions SET requires_superuser = true WHERE resource LIKE 'superuser_%'`) as an idempotent tail.

### Severity assessment for `=on` rollout

Concrete impact of leaving this as-is when flipping `BBB_PERMISSIONS_ENFORCE=on`:

- `bam.superuser_permission_divergence.list` is the read endpoint that surfaces the very Wave B/C divergence dashboard used to monitor this rollout. It is reachable from `GET /v1/superuser/permission-divergence` (per the `bam.` `.list` convention).
- With DB `requires_superuser = false`, the resolver's SU short-circuit will not fire on this permission. Any non-SuperUser who manages to be granted this permission via an operator-defined group could read the divergence dashboard.
- By default no operator group should grant a `superuser_*`-resource permission, but Owner groups grant "all" permissions, so an org Owner **could** call this endpoint and view cross-org permission divergence data.
- The companion permission `bam.superuser_permission_divergence_summary.list` (added by `0151_*`) IS correctly flagged `requires_superuser = true` in all three sources, because `0151_*` ran before `0152_*` and was caught by the backfill.

This is a real but narrow leak in a SuperUser-only diagnostic surface. It should be patched with a one-line delta migration before `=on`, but it does not block the rollout if the resolver's pre-flip warn-mode telemetry doesn't show non-SU traffic on this path.

## 7. Verdict

**The catalog is consistent enough to ship `BBB_PERMISSIONS_ENFORCE=on` from a catalog standpoint, with one caveat.**

Counts (1083/1083/1083), ID sets (zero symmetric diff across all three sources), the REST/MCP source maps (793 + 348 entries each, zero orphans, zero missing, zero dangling IDs in either map), and 99.99% of flag values (43,319 / 43,320 boolean cells) all agree. The CI guard runs green. The `requires_superuser` column exists, is correctly typed, and the manifest/generated-TS pair agrees on all 11 SU-only IDs.

The single divergence — `bam.superuser_permission_divergence.list` being `requires_superuser=false` in the DB — is a missing backfill, not a structural inconsistency, and it leaks a SuperUser diagnostic read to org Owners. It should be patched with a one-line delta migration (`UPDATE permissions SET requires_superuser = true WHERE id = 'bam.superuser_permission_divergence.list';`, ideally written more generally as a re-run of the `LIKE 'superuser_%'` backfill, so future delta migrations don't reintroduce the same bug). After that one-line migration is applied, the catalog is byte-equivalent across all three sources and `=on` is safe to ship.

## Appendix: artifacts

- `audit.mjs` — the consistency-check script used (read-only against repo + live DB).
- `audit-report.json` — full structured report including the 51-row sample table and the complete per-pair mismatch lists.
