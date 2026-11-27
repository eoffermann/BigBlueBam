// bastion-api operator commands (spec 9.7). The worker has no CLI, so the object restore runbook
// lives here, next to the only service that holds the off-site backup credentials.
//
//   node dist/cli.js restore-objects --from-backup [--dry-run]
//
// Compose: docker compose exec bastion-api node dist/cli.js restore-objects --from-backup
// Railway: railway ssh --service bastion-api -- node dist/cli.js restore-objects --from-backup
//
// Copies every evidence file, uploaded file, seal and restore record from the off-site evidence
// backup (BASTION_BACKUP_S3_*) back into the Bastion bucket (BASTION_S3_BUCKET). Objects already
// there with the same size are left alone, so running it twice is safe. It works page by page,
// printing `objects n` with the elapsed time from the first page; a listing that fails stops it
// with a non-zero exit, never a quiet partial restore (#313).
//
// Redaction (#310): when the database answers, files that were redacted are never copied back
// (and a copy already in the bucket is deleted). The copy itself works before the database is
// restored, but then the redaction check cannot run: the command copies, says so, and exits 1 so
// the operator runs it again once the database is back (the second run copies nothing new and
// removes any redacted files).

const started = Date.now();
const log = (line: string) => process.stdout.write(`[bastion-cli +${((Date.now() - started) / 1000).toFixed(1)}s] ${line}\n`);

const USAGE = [
  'Usage: node dist/cli.js restore-objects --from-backup [--dry-run]',
  '',
  '  restore-objects --from-backup   copy the off-site evidence backup back into the Bastion bucket',
  '  --dry-run                       list what would be copied, copy nothing',
].join('\n');

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'restore-objects' || !rest.includes('--from-backup')) {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined || command === '--help' || command === 'help' ? 0 : 2;
  }
  const dryRun = rest.includes('--dry-run');
  log('loading settings (the environment is checked first)...');
  // Imported after the first line: env validation and driver set-up run at import time.
  const { env } = await import('./env.js');
  const { createBackupStorage, createBastionStorage } = await import('./lib/storage.js');
  const { restoreObjectsFromBackup } = await import('./engine/objects.js');
  const mirror = createBackupStorage(env);
  if (!mirror) {
    log('No off-site evidence backup is configured (set BASTION_BACKUP_S3_ENDPOINT, _BUCKET, _ACCESS_KEY and _SECRET_KEY). Nothing to restore from.');
    return 1;
  }
  const bucket = createBastionStorage(env);
  if (!bucket) {
    log(`Evidence storage is not set up (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY for bucket "${env.BASTION_S3_BUCKET}"). Nothing to restore into.`);
    return 1;
  }
  log('connecting to the database to check which files were redacted (up to 10 s)...');
  const { default: postgres } = await import('postgres');
  const { orgTx } = await import('./engine/context.js');
  const sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 10, idle_timeout: 5, onnotice: () => {} });
  let redactedKeys: ((orgId: string) => Promise<Set<string>>) | null = null;
  try {
    await sql`SELECT 1 FROM bastion_evidence_objects LIMIT 1`;
    redactedKeys = async (orgId) =>
      new Set(
        (
          await orgTx(sql, orgId, (tx) => tx`SELECT object_key FROM bastion_evidence_objects
                                             WHERE organization_id = ${orgId} AND bytes_redacted_at IS NOT NULL`)
        ).map((r) => String(r.object_key)),
      );
    log('database reachable: redacted files will not be copied back');
  } catch (err) {
    log(`WARNING: the database is not reachable (${(err as Error).message}); redacted files cannot be told apart yet`);
  }
  log(`${dryRun ? 'DRY RUN: ' : ''}copying from the off-site backup bucket "${env.BASTION_BACKUP_S3_BUCKET}" into "${env.BASTION_S3_BUCKET}"`);
  try {
    const res = await restoreObjectsFromBackup(mirror, bucket, log, { timeoutMs: 60_000, dryRun, redactedKeys });
    log(
      `${dryRun ? 'would copy' : 'copied'} ${res.copied}, already present ${res.already_present}, redacted and left out ${res.redacted_skipped}, failed ${res.failed}, of ${res.listed} objects in the off-site backup`,
    );
    if (res.failed > 0) log('Some objects could not be copied. Run the command again; objects already copied are skipped.');
    if (!res.redaction_checked) {
      log('NOT FINISHED: the redaction check did not run. Run this command again once the database is restored; it copies nothing new and removes any redacted files it copied back.');
    }
    return res.failed > 0 || !res.redaction_checked ? 1 : 0;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    log(`failed: ${(err as Error).message}`);
    process.exit(1);
  },
);
