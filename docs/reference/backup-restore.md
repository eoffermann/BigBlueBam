# Database Backup & Restore (Backup app - Platform scope)

Whole-database backup and restore for BigBlueBam. This protects the thing that
cannot be reconstructed from anywhere else: the Postgres database - every org,
every user login and session, and all app data across every product's schema.
Object storage (MinIO/S3) is deliberately out of scope here; it is configured for
its own durability and is not part of these snapshots.

## Where it lives

SuperUser Console -> **Backups** tab (`/b3/superuser`, SuperUser only). Everything
is driven from the UI - there is no CLI-only path.

## What a backup is

A backup is a `pg_dump` **custom-format archive** (`-Fc`, compressed) of the whole
database, taken with `--no-owner --no-acl` so it is portable and can be restored
into a brand-new instance that does not have the same database roles. Each archive
is uploaded to the shared object store under `backups/platform/` and recorded in
`platform_backups` with its size, server version, and a sha256 integrity token.

Backups run two ways:

- **Automatically**, once per night (worker `backup-database` scheduler, default
  `0 3 * * *` UTC - `BACKUP_SCHEDULE_CRON`). Scheduled backups are pruned to the
  most recent `BACKUP_RETENTION_COUNT` (default 14).
- **On demand**, via **Back up now** in the Backups tab.

## Restoring

Restore is **destructive**: it runs `pg_restore --clean --if-exists`, which drops
and recreates every object, replacing the entire current database with the
snapshot. In the Backups tab, click **Restore** on a completed backup, read the
warning, and type the exact per-backup confirmation phrase
(`RESTORE <first 8 chars of the backup id>`) to enable the button.

Run a restore during a maintenance window - connected users and in-flight work are
disrupted while it runs.

### The three restore targets

The same archive covers every restore scenario, because a `pg_dump` archive is a
portable, self-contained copy of the database:

1. **Roll back this instance to a prior date.** Pick an older backup and restore
   it in place from the Backups tab.
2. **Disaster recovery.** After data loss, restore the most recent good backup in
   place.
3. **A brand-new instance.** Stand up a fresh stack, then restore an archive into
   it. Download the archive (the **Download** button streams it through the api)
   and restore it against the new database during provisioning, or point the new
   instance's restore at that archive.

## Configuration (worker env)

| Var | Default | Meaning |
|---|---|---|
| `BACKUP_SCHEDULE_CRON` | `0 3 * * *` | When the nightly backup runs (UTC). |
| `BACKUP_RETENTION_COUNT` | `14` | Scheduled backups to keep (0 = keep all). |
| `BACKUP_KEY_PREFIX` | `backups/platform` | Object-key prefix in the shared bucket. |
| `S3_*` | (shared) | Bucket/credentials, same as the rest of the platform. |

The worker image includes `postgresql16-client` (pg_dump/pg_restore 16) to match
the Postgres 16 server.

## Data model

- `platform_backups` - one row per archive (kind, status, storage_key, size,
  pg_version, integrity, who triggered it).
- `platform_restores` - one row per restore run, including the typed confirmation
  phrase, for the audit trail. Every backup/restore action is also written to
  `superuser_audit_log`.

Both tables are platform-level and SuperUser-only (no `organization_id`, no RLS
policy).

## Deferred (TODO)

The Backup app was scoped to the **Platform** level first because it is the
immediate need ("do not lose the database"). Two levels are intentionally deferred:

- [ ] **Organization-scoped backup/restore.** A logical export of a single org
      (all its rows across every table, optionally including its users/logins) and
      an import that can re-create that org on the same or a different instance.
      This is a filtered, FK-graph-aware logical export, not a `pg_dump`, and needs
      ID-remap / merge-vs-replace semantics on restore.
- [ ] **Project-scoped backup/restore.** A logical export/import of one project's
      data, including how referenced users (assignees, reporters, comment authors)
      map onto the target org/instance.
- [ ] **MCP tools** for backup/restore, so an agent can trigger and audit backups
      the same way a SuperUser can (`backup_create`, `backup_list`,
      `backup_restore` with the same confirmation-phrase gate).

The `scope` column on `platform_backups` is the forward hook for the first two.
