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
// there with the same size are left alone, so running it twice is safe. Progress is printed as
// `objects n/N` with the elapsed time. It reads only the bucket and environment, never the
// database, so it works before the database is restored.

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
  log(`${dryRun ? 'DRY RUN: ' : ''}copying from the off-site backup bucket "${env.BASTION_BACKUP_S3_BUCKET}" into "${env.BASTION_S3_BUCKET}"`);
  const res = await restoreObjectsFromBackup(mirror, bucket, log, { timeoutMs: 60_000, dryRun });
  log(
    `${dryRun ? 'would copy' : 'copied'} ${res.copied}, already present ${res.already_present}, failed ${res.failed}, of ${res.listed} objects in the off-site backup`,
  );
  if (res.failed > 0) log('Some objects could not be copied. Run the command again; objects already copied are skipped.');
  return res.failed > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    log(`failed: ${(err as Error).message}`);
    process.exit(1);
  },
);
