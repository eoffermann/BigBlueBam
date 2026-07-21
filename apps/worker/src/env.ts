import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().email().default('noreply@bigbluebam.com'),
  TRACKING_BASE_URL: z.string().default('http://localhost'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  BOLT_API_INTERNAL_URL: z.string().url().default('http://bolt-api:4006'),
  // §1 Wave 5 banter subs - pattern-match consumer posts can_access preflights
  // against the Bam api on this URL. Default mirrors docker-compose.
  API_INTERNAL_URL: z.string().url().default('http://api:4000'),
  INTERNAL_SERVICE_SECRET: z.string().default(''),

  // Bin AV-scan (Bin master §9.3). 'eicar' (default) does a dependency-free
  // signature scan — it flags the standard EICAR test string as infected and
  // otherwise marks the object clean, so the serving pipeline is autonomous on
  // a bare stack. 'clamav' streams bytes to a clamd at CLAMAV_HOST:CLAMAV_PORT
  // (INSTREAM). 'off' marks every object 'skipped' (no inspection performed).
  BIN_AV_SCAN_MODE: z.enum(['eicar', 'clamav', 'off']).default('eicar'),
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),

  // Object storage (shared with bin-api). Used by the database backup job to
  // upload pg_dump archives and by the restore job to fetch them.
  S3_ENDPOINT: z.string().default('http://minio:9000'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_BUCKET: z.string().default('bigbluebam-uploads'),
  S3_REGION: z.string().default('us-east-1'),

  // Database backup (Backup app, Platform scope).
  //  - BACKUP_SCHEDULE_CRON: when the nightly automatic backup runs (UTC).
  //  - BACKUP_RETENTION_COUNT: how many scheduled backups to keep (0 = keep all).
  //  - BACKUP_KEY_PREFIX: object-key prefix for dump archives in S3_BUCKET.
  BACKUP_SCHEDULE_CRON: z.string().default('0 3 * * *'), // 3 AM UTC daily
  BACKUP_RETENTION_COUNT: z.coerce.number().int().nonnegative().default(14),
  BACKUP_KEY_PREFIX: z.string().default('backups/platform'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten().fieldErrors);
    throw new Error('Invalid environment variables');
  }
  return result.data;
}
