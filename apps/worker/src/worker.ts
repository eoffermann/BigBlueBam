import 'dotenv/config';
import { Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { loadEnv } from './env.js';
import { createDb, closeDb } from './utils/db.js';
import { recordWorkerError } from './utils/record-error.js';
import { processEmailJob, type EmailJobData } from './jobs/email.job.js';
import { processNotificationJob, type NotificationJobData } from './jobs/notification.job.js';
import { processSprintCloseJob, type SprintCloseJobData } from './jobs/sprint-close.job.js';
import { processExportJob, type ExportJobData } from './jobs/export.job.js';
import { processBanterNotificationJob, type BanterNotificationJobData } from './jobs/banter-notification.job.js';
import { processBanterRetentionJob, type BanterRetentionJobData } from './jobs/banter-retention.job.js';
import { processBanterTranscriptionJob, type BanterTranscriptionJobData } from './jobs/banter-transcription.job.js';
import { processHelpdeskTaskCreateJob, type HelpdeskTaskCreateJobData } from './jobs/helpdesk-task-create.job.js';
import { processBeaconVectorSyncJob, type BeaconVectorSyncJobData } from './jobs/beacon-vector-sync.job.js';
import { processBeaconExpirySweepJob, type BeaconExpirySweepJobData } from './jobs/beacon-expiry-sweep.job.js';
import { processLivekitIpDriftJob, type LivekitIpDriftJobData } from './jobs/livekit-ip-drift.job.js';
import { processTurnCertExpiryJob, type TurnCertExpiryJobData } from './jobs/turn-cert-expiry.job.js';
import { processBearingSnapshotJob, type BearingSnapshotJobData } from './jobs/bearing-snapshot.job.js';
import { processBearingRecomputeJob, type BearingRecomputeJobData } from './jobs/bearing-recompute.job.js';
import { processBearingDigestJob, type BearingDigestJobData } from './jobs/bearing-digest.job.js';
import { processBoltExecuteJob, type BoltExecuteJobData } from './jobs/bolt-execute.job.js';
import {
  processBoltScheduleTickJob,
  type BoltScheduleTickJobData,
} from './jobs/bolt-schedule-tick.job.js';
import { processBlastSendJob, type BlastSendJobData } from './jobs/blast-send.job.js';
import { processBondStaleDealsJob, type BondStaleDealsJobData } from './jobs/bond-stale-deals.job.js';
import {
  processBillPdfGenerateJob,
  type BillPdfGenerateJobData,
} from './jobs/bill-pdf-generate.job.js';
import {
  processBillEmailSendJob,
  type BillEmailSendJobData,
} from './jobs/bill-email-send.job.js';
import {
  processBillOverdueReminderJob,
  type BillOverdueReminderJobData,
} from './jobs/bill-overdue-reminder.job.js';
import {
  processBillRecurringGenerateJob,
  type BillRecurringGenerateJobData,
} from './jobs/bill-recurring-generate.job.js';
import {
  processBlankConfirmationEmailJob,
  type BlankConfirmationEmailJobData,
} from './jobs/blank-confirmation-email.job.js';
import {
  processBlankFileProcessJob,
  type BlankFileProcessJobData,
} from './jobs/blank-file-process.job.js';
import {
  processBenchReportDeliverJob,
  type BenchReportDeliverJobData,
} from './jobs/bench-report-deliver.job.js';
import {
  processBenchMvRefreshJob,
  type BenchMvRefreshJobData,
} from './jobs/bench-mv-refresh.job.js';
import { processBriefEmbedJob, type BriefEmbedJobData } from './jobs/brief-embed.job.js';
import { processBriefSnapshotJob, type BriefSnapshotJobData } from './jobs/brief-snapshot.job.js';
import { processBriefExportJob, type BriefExportJobData } from './jobs/brief-export.job.js';
import { processBriefCleanupJob, type BriefCleanupJobData } from './jobs/brief-cleanup.job.js';
import {
  processHelpdeskSlaMonitorJob,
  type HelpdeskSlaMonitorJobData,
} from './jobs/helpdesk-sla-monitor.job.js';
import {
  processBearingWatcherNotifyJob,
  type BearingWatcherNotifyJobData,
} from './jobs/bearing-watcher-notify.job.js';
import {
  processBoardThumbnailJob,
  type BoardThumbnailJobData,
} from './jobs/board-thumbnail.job.js';
import {
  processBoltExecutionCleanupJob,
  type BoltExecutionCleanupJobData,
} from './jobs/bolt-execution-cleanup.job.js';
import {
  processBondBulkScoreJob,
  type BondBulkScoreJobData,
} from './jobs/bond-bulk-score.job.js';
import {
  processHelpdeskEmailNotifyJob,
  type HelpdeskEmailNotifyJobData,
} from './jobs/helpdesk-email-notify.job.js';
// §13 Wave 4 scheduled banter
import {
  processBanterScheduledPostJob,
  reconcileScheduledPosts,
  type BanterScheduledPostJobData,
} from './jobs/banter-scheduled-post.job.js';
// §1 Wave 5 banter subs
import { startBanterPatternMatchConsumer } from './jobs/banter-pattern-match.job.js';
// Banter Feed fan-in (docs/plans/banter-feed-design-document.md §10)
import {
  processBanterFeedFaninJob,
  type BanterFeedFaninJobData,
} from './jobs/banter-feed-fanin.job.js';
// §20 Wave 5 webhooks
import {
  processAgentWebhookDispatchJob,
  type AgentWebhookDispatchJobData,
} from './jobs/agent-webhook-dispatch.job.js';
import {
  processAgentWebhookDlqJob,
  type AgentWebhookDlqJobData,
} from './jobs/agent-webhook-dlq.job.js';
// Slack workspace -> Banter importer (docs/plans/slack-import-design.md).
import {
  processSlackImportJob,
  type SlackImportJobData,
} from './jobs/slack-import.job.js';
// Phase 0 task Links field — external-URL title fetch, enqueued by the Bam
// api when a link is added without a title (docs/plans/bam-csv-import-plan.md §4.3).
import {
  processTaskLinkTitleFetchJob,
  type TaskLinkTitleFetchJobData,
} from './jobs/task-link-title-fetch.job.js';
// §13 Bureau presence reaper — sweep sessions whose Redis TTL has lapsed,
// emit room_leave + presence_delta, close the durable session row.
import {
  processBureauPresenceReapJob,
  type BureauPresenceReapJobData,
} from './jobs/bureau-presence-reap.js';
import {
  processBureauChatExpiryJob,
  type BureauChatExpiryJobData,
} from './jobs/bureau-chat-expiry.job.js';
// §10 Bureau summon fan-out — large-room recipient delivery off the WS hot path.
import {
  processBureauSummonFanoutJob,
  type BureauSummonFanoutJobData,
} from './jobs/bureau-summon-fanout.js';
// §4.3 Bureau knock timeout — fires 30s after a knock is created and auto-
// resolves any still-pending knock as `timed_out`.
import {
  processBureauKnockTimeoutJob,
  type BureauKnockTimeoutJobData,
} from './jobs/bureau-knock-timeout.js';
// Workstream 4: Bureau booking lifecycle — delayed jobs that apply the
// door privacy override at starts_at and clear it at ends_at.
import {
  processBureauBookingActivateJob,
  processBureauBookingReleaseJob,
  type BureauBookingActivateJobData,
  type BureauBookingReleaseJobData,
} from './jobs/bureau-booking-lifecycle.js';
// Workstream 14: Bureau daily analytics rollup. Cron `0 0 * * *` writes one
// row per floor per day into bureau_floor_analytics for Bench dashboards.
import {
  processBureauAnalyticsRollupJob,
  type BureauAnalyticsRollupJobData,
} from './jobs/bureau-analytics-rollup.js';
// Book task #63: external-calendar sync sweep — triggers the Book API's
// internal sync engine for every due connection (ICS feeds today).
import {
  processBookCalendarSyncJob,
  type BookCalendarSyncJobData,
} from './jobs/book-calendar-sync.job.js';
// Bin AV-scan sweep — the suite's first virus scanner. Flips pending bin_assets
// to clean/infected/skipped so the §9.3 serving gate is autonomous.
import {
  processBinAvScanJob,
  type BinAvScanJobData,
} from './jobs/bin-av-scan.job.js';
// Bin media transcode — proxy/poster generation for clean media versions.
import {
  processBinTranscodeJob,
  type BinTranscodeJobData,
} from './jobs/bin-transcode.job.js';
// Bin model processing — FBX/OBJ/STL/... -> GLB proxy + probe (Bay FBX 3D review).
import {
  processBinModelProcessJob,
  type BinModelProcessJobData,
} from './jobs/bin-model-process.job.js';
// Blip telemetry worker jobs (docs/plans/BigBlueBam_Blip_Design_Document.md §4.2,
// §11.2, §12, §14, §23). Queue contracts live in @bigbluebam/shared.
import {
  BLIP_INGEST_QUEUE,
  BLIP_EXPORT_JSONL_QUEUE,
  BLIP_TIMELAPSE_QUEUE,
  BLIP_FIELD_INDEX_QUEUE,
  type BlipIngestJobData,
  type BlipExportJobData,
  type BlipTimelapseJobData,
  type BlipFieldIndexJobData,
} from '@bigbluebam/shared';
import { processBlipIngestJob } from './jobs/blip-ingest.job.js';
import {
  processBlipPartitionProvisionJob,
  type BlipPartitionProvisionJobData,
} from './jobs/blip-partition-provision.job.js';
import {
  processBlipRetentionSweepJob,
  type BlipRetentionSweepJobData,
} from './jobs/blip-retention-sweep.job.js';
import {
  processBlipWatchEvalJob,
  type BlipWatchEvalJobData,
} from './jobs/blip-watch-eval.job.js';
import { processBlipFieldIndexJob } from './jobs/blip-field-index.job.js';
import { processBlipExportJsonlJob } from './jobs/blip-export-jsonl.job.js';
import { processBlipTimelapseJob } from './jobs/blip-timelapse.job.js';

const env = loadEnv();

const logger = pino({
  level: env.LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

logger.info({ concurrency: env.WORKER_CONCURRENCY }, 'Starting BigBlueBam worker');

// Connect to Redis
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

redis.on('connect', () => logger.info('Connected to Redis'));
redis.on('error', (err) => logger.error({ err }, 'Redis connection error'));

// Connect to Postgres via Drizzle
createDb(env.DATABASE_URL);
logger.info('Connected to Postgres');

// BullMQ connection options
const connection = { connection: redis };

// Email worker
const emailWorker = new Worker<EmailJobData>(
  'email',
  async (job: Job<EmailJobData>) => {
    await processEmailJob(job, env, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);

emailWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'email' }, 'Job completed');
});

emailWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'email', err }, 'Job failed');
  // Mirror the failure into system_errors so the SuperUser Console's
  // Log Analysis tab can surface it. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'email',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Notifications worker
const notificationWorker = new Worker<NotificationJobData>(
  'notifications',
  async (job: Job<NotificationJobData>) => {
    await processNotificationJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);

notificationWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'notifications' }, 'Job completed');
});

notificationWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'notifications', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'notifications',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Sprint close worker
const sprintCloseWorker = new Worker<SprintCloseJobData>(
  'sprint-close',
  async (job: Job<SprintCloseJobData>) => {
    await processSprintCloseJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);

sprintCloseWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'sprint-close' }, 'Job completed');
});

sprintCloseWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'sprint-close', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'sprint-close',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Export worker
const exportWorker = new Worker<ExportJobData>(
  'export',
  async (job: Job<ExportJobData>) => {
    await processExportJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);

exportWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'export' }, 'Job completed');
});

exportWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'export', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'export',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Banter notification worker
const banterNotificationWorker = new Worker<BanterNotificationJobData>(
  'banter-notifications',
  async (job: Job<BanterNotificationJobData>) => {
    await processBanterNotificationJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);

banterNotificationWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'banter-notifications' }, 'Job completed');
});

banterNotificationWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'banter-notifications', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'banter-notifications',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Banter data retention worker
const banterRetentionWorker = new Worker<BanterRetentionJobData>(
  'banter-retention',
  async (job: Job<BanterRetentionJobData>) => {
    await processBanterRetentionJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);

banterRetentionWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'banter-retention' }, 'Job completed');
});

banterRetentionWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'banter-retention', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'banter-retention',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Banter call transcription worker (post-call STT via voice-agent)
const banterTranscriptionWorker = new Worker<BanterTranscriptionJobData>(
  'banter-transcription',
  async (job: Job<BanterTranscriptionJobData>) => {
    await processBanterTranscriptionJob(job, logger);
  },
  { ...connection, concurrency: 2 },
);

banterTranscriptionWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'banter-transcription' }, 'Job completed');
});

banterTranscriptionWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'banter-transcription', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'banter-transcription',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// §13 Wave 4 scheduled banter — delayed and quiet-hours-deferred post delivery.
const banterScheduledPostWorker = new Worker<BanterScheduledPostJobData>(
  'banter-scheduled-post',
  async (job: Job<BanterScheduledPostJobData>) => {
    await processBanterScheduledPostJob(job, redis, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);

banterScheduledPostWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'banter-scheduled-post' }, 'Job completed');
});

banterScheduledPostWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'banter-scheduled-post', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'banter-scheduled-post',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Schedule banter retention as a daily cron (1 AM UTC, offset from other sweeps)
const banterRetentionQueue = new Queue('banter-retention', { connection: redis });
banterRetentionQueue
  .upsertJobScheduler(
    'banter-retention-daily',
    { pattern: '0 1 * * *' }, // 1 AM daily
    { name: 'daily-retention', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register banter retention scheduler'));

// Helpdesk task-create worker (HB-23 — async fallback for ticket→task creation)
const helpdeskTaskCreateWorker = new Worker<HelpdeskTaskCreateJobData>(
  'helpdesk-task-create',
  async (job: Job<HelpdeskTaskCreateJobData>) => {
    await processHelpdeskTaskCreateJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);

helpdeskTaskCreateWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'helpdesk-task-create' }, 'Job completed');
});

helpdeskTaskCreateWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'helpdesk-task-create', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'helpdesk-task-create',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Beacon vector sync worker
const beaconVectorSyncWorker = new Worker<BeaconVectorSyncJobData>(
  'beacon-vector-sync',
  async (job: Job<BeaconVectorSyncJobData>) => {
    await processBeaconVectorSyncJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);

beaconVectorSyncWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'beacon-vector-sync' }, 'Job completed');
});

beaconVectorSyncWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'beacon-vector-sync', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'beacon-vector-sync',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Beacon expiry sweep worker (Fridge Cleanout §6.1 — daily cron)
const beaconExpirySweepWorker = new Worker<BeaconExpirySweepJobData>(
  'beacon-expiry-sweep',
  async (job: Job<BeaconExpirySweepJobData>) => {
    await processBeaconExpirySweepJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);

beaconExpirySweepWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'beacon-expiry-sweep' }, 'Job completed');
});

beaconExpirySweepWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'beacon-expiry-sweep', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'beacon-expiry-sweep',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Schedule the expiry sweep as a daily repeatable job
import { Queue } from 'bullmq';
const beaconExpirySweepQueue = new Queue('beacon-expiry-sweep', { connection: redis });
beaconExpirySweepQueue.upsertJobScheduler(
  'beacon-expiry-sweep-daily',
  { pattern: '0 3 * * *' }, // 3 AM daily
  { name: 'daily-sweep', data: {} },
).catch((err) => logger.error({ err }, 'Failed to register beacon expiry sweep scheduler'));

// LiveKit address-drift watchdog (hourly). Compares the public IP
// LiveKit is advertising (advertised.json, rendered by the
// livekit-config service) against a fresh STUN detection, and writes a
// LIVEKIT_WAN_IP_DRIFT row to system_errors with the remediation
// command when the ISP rotated the address out from under the running
// config. The worker can't restart containers, so loud-and-actionable
// is the contract here.
const livekitIpDriftWorker = new Worker<LivekitIpDriftJobData>(
  'livekit-ip-drift',
  async (job: Job<LivekitIpDriftJobData>) => {
    await processLivekitIpDriftJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);

livekitIpDriftWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'livekit-ip-drift' }, 'Job completed');
});

livekitIpDriftWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'livekit-ip-drift', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'livekit-ip-drift',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Hourly at :17 — offset from the pile of on-the-hour jobs.
const livekitIpDriftQueue = new Queue('livekit-ip-drift', { connection: redis });
livekitIpDriftQueue.upsertJobScheduler(
  'livekit-ip-drift-hourly',
  { pattern: '17 * * * *' },
  { name: 'drift-check', data: {} },
).catch((err) => logger.error({ err }, 'Failed to register livekit ip drift scheduler'));

// TURN-TLS certificate expiry watchdog (daily). On Railway TURN is the
// only media path and the cert is delivered as env-var PEMs (no
// auto-renew possible) — an expired cert silently kills calling, so the
// worker warns the Log at T-14 days with the exact renewal steps. The
// job no-ops when LIVEKIT_TURN_CHECK_TARGET is unset (LAN deploys).
const turnCertExpiryWorker = new Worker<TurnCertExpiryJobData>(
  'turn-cert-expiry',
  async (job: Job<TurnCertExpiryJobData>) => {
    await processTurnCertExpiryJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);

turnCertExpiryWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'turn-cert-expiry' }, 'Job completed');
});

turnCertExpiryWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'turn-cert-expiry', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'turn-cert-expiry',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

const turnCertExpiryQueue = new Queue('turn-cert-expiry', { connection: redis });
turnCertExpiryQueue.upsertJobScheduler(
  'turn-cert-expiry-daily',
  { pattern: '23 4 * * *' }, // 04:23 UTC daily
  { name: 'cert-check', data: {} },
).catch((err) => logger.error({ err }, 'Failed to register turn cert expiry scheduler'));

// Schedule bearing snapshot as a daily repeatable job (midnight UTC)
const bearingSnapshotQueue = new Queue('bearing-snapshot', { connection: redis });
bearingSnapshotQueue.upsertJobScheduler(
  'bearing-snapshot-daily',
  { pattern: '0 0 * * *' }, // midnight UTC
  { name: 'daily-snapshot', data: {} },
).catch((err) => logger.error({ err }, 'Failed to register bearing snapshot scheduler'));

// Bearing snapshot worker (daily KR progress snapshots)
const bearingSnapshotWorker = new Worker<BearingSnapshotJobData>(
  'bearing-snapshot',
  async (job: Job<BearingSnapshotJobData>) => {
    await processBearingSnapshotJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);

bearingSnapshotWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bearing-snapshot' }, 'Job completed');
});

bearingSnapshotWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bearing-snapshot', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bearing-snapshot',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Bearing recompute worker (recalculates KR progress from Bam data)
const bearingRecomputeWorker = new Worker<BearingRecomputeJobData>(
  'bearing-recompute',
  async (job: Job<BearingRecomputeJobData>) => {
    await processBearingRecomputeJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);

bearingRecomputeWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bearing-recompute' }, 'Job completed');
});

bearingRecomputeWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bearing-recompute', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bearing-recompute',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Bearing digest worker (weekly goals summary)
const bearingDigestWorker = new Worker<BearingDigestJobData>(
  'bearing-digest',
  async (job: Job<BearingDigestJobData>) => {
    await processBearingDigestJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);

bearingDigestWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bearing-digest' }, 'Job completed');
});

bearingDigestWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bearing-digest', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bearing-digest',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Bearing watcher-notify worker (emails goal watchers on status changes)
const bearingWatcherNotifyWorker = new Worker<BearingWatcherNotifyJobData>(
  'bearing-watcher-notify',
  async (job: Job<BearingWatcherNotifyJobData>) => {
    await processBearingWatcherNotifyJob(job, env, logger);
  },
  { ...connection, concurrency: 1 },
);
bearingWatcherNotifyWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bearing-watcher-notify' }, 'Job completed');
});
bearingWatcherNotifyWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bearing-watcher-notify', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bearing-watcher-notify',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Bolt execution worker (runs automation action sequences via MCP tool calls)
const boltExecuteWorker = new Worker<BoltExecuteJobData>(
  'bolt-execute',
  async (job: Job<BoltExecuteJobData>) => {
    await processBoltExecuteJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);

boltExecuteWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bolt-execute' }, 'Job completed');
});

boltExecuteWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bolt-execute', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bolt-execute',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Bolt schedule tick worker (G2 — scans bolt_schedules every minute and fires
// synthetic cron.fired events for due rows)
const boltScheduleTickWorker = new Worker<BoltScheduleTickJobData>(
  'bolt-schedule',
  async (job: Job<BoltScheduleTickJobData>) => {
    await processBoltScheduleTickJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);

boltScheduleTickWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bolt-schedule' }, 'Job completed');
});

boltScheduleTickWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bolt-schedule', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bolt-schedule',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Schedule bolt schedule-tick as a once-a-minute repeating job
const boltScheduleQueue = new Queue('bolt-schedule', { connection: redis });
boltScheduleQueue.upsertJobScheduler(
  'bolt-schedule-tick',
  { pattern: '* * * * *' }, // every minute
  { name: 'tick', data: {} },
).catch((err) => logger.error({ err }, 'Failed to register bolt schedule tick scheduler'));

// Blast send worker (processes campaign email delivery)
const blastSendWorker = new Worker<BlastSendJobData>(
  'blast-send',
  async (job: Job<BlastSendJobData>) => {
    await processBlastSendJob(job, env, logger);
  },
  { ...connection, concurrency: 1 }, // serialize campaign sends to respect SMTP rate limits
);

blastSendWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'blast-send' }, 'Job completed');
});

blastSendWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'blast-send', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'blast-send',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Bond stale-deals worker (daily cron — detects rotting deals and emits bolt events)
const bondStaleDealsWorker = new Worker<BondStaleDealsJobData>(
  'bond-stale-deals',
  async (job: Job<BondStaleDealsJobData>) => {
    await processBondStaleDealsJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);

bondStaleDealsWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bond-stale-deals' }, 'Job completed');
});

bondStaleDealsWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bond-stale-deals', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bond-stale-deals',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Schedule bond stale-deals sweep as a daily repeatable job at 02:00 UTC
// (offset from beacon-expiry-sweep @ 03:00 and bearing-snapshot @ 00:00)
const bondStaleDealsQueue = new Queue('bond-stale-deals', { connection: redis });
bondStaleDealsQueue.upsertJobScheduler(
  'bond-stale-deals-daily',
  { pattern: '0 2 * * *' }, // 2 AM daily
  { name: 'daily-sweep', data: {} },
).catch((err) => logger.error({ err }, 'Failed to register bond stale-deals scheduler'));

// ---------------------------------------------------------------------------
// Wave 2C deferred workers (Bill, Blank, Bench, Brief, Helpdesk).
// ---------------------------------------------------------------------------

// Bill PDF-generate worker. Handles direct {workerJobId} jobs and runs a
// repeatable sweep every 2 minutes against pending bill_worker_jobs rows.
const billPdfGenerateWorker = new Worker<BillPdfGenerateJobData>(
  'bill-pdf-generate',
  async (job: Job<BillPdfGenerateJobData>) => {
    await processBillPdfGenerateJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
billPdfGenerateWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bill-pdf-generate' }, 'Job completed');
});
billPdfGenerateWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bill-pdf-generate', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bill-pdf-generate',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const billPdfGenerateQueue = new Queue('bill-pdf-generate', { connection: redis });
billPdfGenerateQueue
  .upsertJobScheduler(
    'bill-pdf-generate-sweep',
    { pattern: '*/2 * * * *' },
    { name: 'sweep', data: { sweep: true } },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bill-pdf-generate sweep scheduler'));

// Bill email-send worker.
const billEmailSendWorker = new Worker<BillEmailSendJobData>(
  'bill-email-send',
  async (job: Job<BillEmailSendJobData>) => {
    await processBillEmailSendJob(job, env, logger);
  },
  { ...connection, concurrency: 1 },
);
billEmailSendWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bill-email-send' }, 'Job completed');
});
billEmailSendWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bill-email-send', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bill-email-send',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const billEmailSendQueue = new Queue('bill-email-send', { connection: redis });
billEmailSendQueue
  .upsertJobScheduler(
    'bill-email-send-sweep',
    { pattern: '*/2 * * * *' },
    { name: 'sweep', data: { sweep: true } },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bill-email-send sweep scheduler'));

// Bill overdue-reminder worker (daily at 09:00 UTC).
const billOverdueReminderWorker = new Worker<BillOverdueReminderJobData>(
  'bill-overdue-reminder',
  async (job: Job<BillOverdueReminderJobData>) => {
    await processBillOverdueReminderJob(job, env, logger);
  },
  { ...connection, concurrency: 1 },
);
billOverdueReminderWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bill-overdue-reminder' }, 'Job completed');
});
billOverdueReminderWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bill-overdue-reminder', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bill-overdue-reminder',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const billOverdueReminderQueue = new Queue('bill-overdue-reminder', { connection: redis });
billOverdueReminderQueue
  .upsertJobScheduler(
    'bill-overdue-reminder-daily',
    { pattern: '0 9 * * *' },
    { name: 'daily', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bill-overdue-reminder scheduler'));

// Bill recurring-invoice generation sweep (daily at 06:00 UTC). Finds active
// schedules due (next_run_at <= now), materialises a draft/finalized invoice
// from each template, and advances next_run_at by the cadence.
const billRecurringGenerateWorker = new Worker<BillRecurringGenerateJobData>(
  'bill-recurring-generate',
  async (job: Job<BillRecurringGenerateJobData>) => {
    await processBillRecurringGenerateJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
billRecurringGenerateWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bill-recurring-generate' }, 'Job completed');
});
billRecurringGenerateWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bill-recurring-generate', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bill-recurring-generate',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const billRecurringGenerateQueue = new Queue('bill-recurring-generate', { connection: redis });
billRecurringGenerateQueue
  .upsertJobScheduler(
    'bill-recurring-generate-daily',
    { pattern: '0 6 * * *' }, // 6 AM UTC daily
    { name: 'daily-sweep', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bill-recurring-generate scheduler'));

// Blank confirmation-email worker.
const blankConfirmationEmailWorker = new Worker<BlankConfirmationEmailJobData>(
  'blank-confirmation-email',
  async (job: Job<BlankConfirmationEmailJobData>) => {
    await processBlankConfirmationEmailJob(job, env, redis, logger);
  },
  { ...connection, concurrency: 1 },
);
blankConfirmationEmailWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'blank-confirmation-email' }, 'Job completed');
});
blankConfirmationEmailWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'blank-confirmation-email', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'blank-confirmation-email',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const blankConfirmationEmailQueue = new Queue('blank-confirmation-email', { connection: redis });
blankConfirmationEmailQueue
  .upsertJobScheduler(
    'blank-confirmation-email-sweep',
    { pattern: '*/2 * * * *' },
    { name: 'sweep', data: { sweep: true } },
  )
  .catch((err) =>
    logger.error({ err }, 'Failed to register blank-confirmation-email sweep scheduler'),
  );

// Blank file-processing worker.
const blankFileProcessWorker = new Worker<BlankFileProcessJobData>(
  'blank-file-process',
  async (job: Job<BlankFileProcessJobData>) => {
    await processBlankFileProcessJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
blankFileProcessWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'blank-file-process' }, 'Job completed');
});
blankFileProcessWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'blank-file-process', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'blank-file-process',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const blankFileProcessQueue = new Queue('blank-file-process', { connection: redis });
blankFileProcessQueue
  .upsertJobScheduler(
    'blank-file-process-sweep',
    { pattern: '*/5 * * * *' },
    { name: 'sweep', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register blank-file-process sweep scheduler'));

// Bench scheduled-report delivery worker.
const benchReportDeliverWorker = new Worker<BenchReportDeliverJobData>(
  'bench-report-deliver',
  async (job: Job<BenchReportDeliverJobData>) => {
    await processBenchReportDeliverJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
benchReportDeliverWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bench-report-deliver' }, 'Job completed');
});
benchReportDeliverWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bench-report-deliver', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bench-report-deliver',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Bench materialized-view refresh scheduler (every 5 minutes).
const benchMvRefreshWorker = new Worker<BenchMvRefreshJobData>(
  'bench-mv-refresh',
  async (job: Job<BenchMvRefreshJobData>) => {
    await processBenchMvRefreshJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
benchMvRefreshWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bench-mv-refresh' }, 'Job completed');
});
benchMvRefreshWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bench-mv-refresh', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bench-mv-refresh',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const benchMvRefreshQueue = new Queue('bench-mv-refresh', { connection: redis });
benchMvRefreshQueue
  .upsertJobScheduler(
    'bench-mv-refresh-tick',
    { pattern: '*/5 * * * *' },
    { name: 'tick', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bench-mv-refresh scheduler'));

// Brief document embedding worker (every 5 minutes).
const briefEmbedWorker = new Worker<BriefEmbedJobData>(
  'brief-embed',
  async (job: Job<BriefEmbedJobData>) => {
    await processBriefEmbedJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
briefEmbedWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'brief-embed' }, 'Job completed');
});
briefEmbedWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'brief-embed', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'brief-embed',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const briefEmbedQueue = new Queue('brief-embed', { connection: redis });
briefEmbedQueue
  .upsertJobScheduler(
    'brief-embed-tick',
    { pattern: '*/5 * * * *' },
    { name: 'tick', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register brief-embed scheduler'));

// Brief document snapshot worker (daily at 4 AM UTC).
const briefSnapshotWorker = new Worker<BriefSnapshotJobData>(
  'brief-snapshot',
  async (job: Job<BriefSnapshotJobData>) => {
    await processBriefSnapshotJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
briefSnapshotWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'brief-snapshot' }, 'Job completed');
});
briefSnapshotWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'brief-snapshot', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'brief-snapshot',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const briefSnapshotQueue = new Queue('brief-snapshot', { connection: redis });
briefSnapshotQueue
  .upsertJobScheduler(
    'brief-snapshot-daily',
    { pattern: '0 4 * * *' }, // 4 AM daily
    { name: 'daily-snapshot', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register brief-snapshot scheduler'));

// Brief document export worker (on-demand, no schedule).
const briefExportWorker = new Worker<BriefExportJobData>(
  'brief-export',
  async (job: Job<BriefExportJobData>) => {
    await processBriefExportJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
briefExportWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'brief-export' }, 'Job completed');
});
briefExportWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'brief-export', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'brief-export',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Brief cleanup worker (weekly, Sunday 5 AM UTC).
const briefCleanupWorker = new Worker<BriefCleanupJobData>(
  'brief-cleanup',
  async (job: Job<BriefCleanupJobData>) => {
    await processBriefCleanupJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
briefCleanupWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'brief-cleanup' }, 'Job completed');
});
briefCleanupWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'brief-cleanup', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'brief-cleanup',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const briefCleanupQueue = new Queue('brief-cleanup', { connection: redis });
briefCleanupQueue
  .upsertJobScheduler(
    'brief-cleanup-weekly',
    { pattern: '0 5 * * 0' }, // Sunday 5 AM UTC
    { name: 'weekly-cleanup', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register brief-cleanup scheduler'));

// Helpdesk SLA monitor (every 5 minutes).
const helpdeskSlaMonitorWorker = new Worker<HelpdeskSlaMonitorJobData>(
  'helpdesk-sla-monitor',
  async (job: Job<HelpdeskSlaMonitorJobData>) => {
    await processHelpdeskSlaMonitorJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
helpdeskSlaMonitorWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'helpdesk-sla-monitor' }, 'Job completed');
});
helpdeskSlaMonitorWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'helpdesk-sla-monitor', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'helpdesk-sla-monitor',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const helpdeskSlaMonitorQueue = new Queue('helpdesk-sla-monitor', { connection: redis });
helpdeskSlaMonitorQueue
  .upsertJobScheduler(
    'helpdesk-sla-monitor-tick',
    { pattern: '*/5 * * * *' },
    { name: 'tick', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register helpdesk-sla-monitor scheduler'));

// Board thumbnail generation worker (on-demand + daily sweep at 04:00 UTC).
const boardThumbnailWorker = new Worker<BoardThumbnailJobData>(
  'board-thumbnail',
  async (job: Job<BoardThumbnailJobData>) => {
    await processBoardThumbnailJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
boardThumbnailWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'board-thumbnail' }, 'Job completed');
});
boardThumbnailWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'board-thumbnail', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'board-thumbnail',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const boardThumbnailQueue = new Queue('board-thumbnail', { connection: redis });
boardThumbnailQueue
  .upsertJobScheduler(
    'board-thumbnail-sweep-daily',
    { pattern: '0 4 * * *' }, // 4 AM daily
    { name: 'sweep', data: { sweep: true } },
  )
  .catch((err) => logger.error({ err }, 'Failed to register board-thumbnail sweep scheduler'));

// Bolt execution cleanup worker (daily at 03:30 UTC).
const boltExecutionCleanupWorker = new Worker<BoltExecutionCleanupJobData>(
  'bolt-execution-cleanup',
  async (job: Job<BoltExecutionCleanupJobData>) => {
    await processBoltExecutionCleanupJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
boltExecutionCleanupWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bolt-execution-cleanup' }, 'Job completed');
});
boltExecutionCleanupWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bolt-execution-cleanup', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bolt-execution-cleanup',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const boltExecutionCleanupQueue = new Queue('bolt-execution-cleanup', { connection: redis });
boltExecutionCleanupQueue
  .upsertJobScheduler(
    'bolt-execution-cleanup-daily',
    { pattern: '30 3 * * *' }, // 3:30 AM daily
    { name: 'daily-cleanup', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bolt-execution-cleanup scheduler'));

// Bond bulk lead-score recalculation worker (daily at 05:00 UTC).
const bondBulkScoreWorker = new Worker<BondBulkScoreJobData>(
  'bond-bulk-score',
  async (job: Job<BondBulkScoreJobData>) => {
    await processBondBulkScoreJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
bondBulkScoreWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bond-bulk-score' }, 'Job completed');
});
bondBulkScoreWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bond-bulk-score', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bond-bulk-score',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const bondBulkScoreQueue = new Queue('bond-bulk-score', { connection: redis });
bondBulkScoreQueue
  .upsertJobScheduler(
    'bond-bulk-score-daily',
    { pattern: '0 5 * * *' }, // 5 AM daily
    { name: 'daily-score', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bond-bulk-score scheduler'));

// §20 Wave 5 webhooks: outbound dispatcher to agent runners.
const agentWebhookDispatchWorker = new Worker<AgentWebhookDispatchJobData>(
  'agent-webhook-dispatch',
  async (job: Job<AgentWebhookDispatchJobData>) => {
    await processAgentWebhookDispatchJob(job, redis, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
agentWebhookDispatchWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'agent-webhook-dispatch' }, 'Job completed');
});
agentWebhookDispatchWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'agent-webhook-dispatch', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'agent-webhook-dispatch',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// §20 Wave 5 webhooks: dead-letter notifier, runs every 5 minutes.
const agentWebhookDlqWorker = new Worker<AgentWebhookDlqJobData>(
  'agent-webhook-dlq',
  async (job: Job<AgentWebhookDlqJobData>) => {
    await processAgentWebhookDlqJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
agentWebhookDlqWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'agent-webhook-dlq' }, 'Job completed');
});
agentWebhookDlqWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'agent-webhook-dlq', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'agent-webhook-dlq',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const agentWebhookDlqQueue = new Queue('agent-webhook-dlq', { connection: redis });
agentWebhookDlqQueue
  .upsertJobScheduler(
    'agent-webhook-dlq-tick',
    { pattern: '*/5 * * * *' }, // every 5 minutes
    { name: 'tick', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register agent-webhook-dlq scheduler'));

// Helpdesk email notification worker.
const helpdeskEmailNotifyWorker = new Worker<HelpdeskEmailNotifyJobData>(
  'helpdesk-email-notify',
  async (job: Job<HelpdeskEmailNotifyJobData>) => {
    await processHelpdeskEmailNotifyJob(job, env, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
helpdeskEmailNotifyWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'helpdesk-email-notify' }, 'Job completed');
});
helpdeskEmailNotifyWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'helpdesk-email-notify', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'helpdesk-email-notify',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Slack -> Banter import worker. Long-running per job (seconds to hours
// for big workspaces); kept at concurrency 1 so a single archive doesn't
// monopolize the DB and so cancellation semantics stay simple.
const slackImportWorker = new Worker<SlackImportJobData>(
  'slack-import',
  async (job: Job<SlackImportJobData>) => {
    await processSlackImportJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
slackImportWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'slack-import' }, 'Job completed');
});
slackImportWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'slack-import', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'slack-import',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Phase 0 task Links — external-URL title fetch. Enqueue-driven only (no
// cron): the api enqueues one job per link saved without a user title.
const taskLinkTitleFetchWorker = new Worker<TaskLinkTitleFetchJobData>(
  'task-link-title-fetch',
  async (job: Job<TaskLinkTitleFetchJobData>) => {
    await processTaskLinkTitleFetchJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
taskLinkTitleFetchWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'task-link-title-fetch' }, 'Job completed');
});
taskLinkTitleFetchWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'task-link-title-fetch', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'task-link-title-fetch',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// §13 Bureau presence reaper — every 15s, sweep `bureau:sess:*` for keys
// whose TTL has lapsed and close the durable session row + broadcast
// room_leave / presence_delta. Concurrency 1: one reaper, one Redis SCAN.
const bureauPresenceReapWorker = new Worker<BureauPresenceReapJobData>(
  'bureau-presence-reap',
  async (job: Job<BureauPresenceReapJobData>) => {
    await processBureauPresenceReapJob(job, redis, logger);
  },
  { ...connection, concurrency: 1 },
);
bureauPresenceReapWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id, queue: 'bureau-presence-reap' }, 'Job completed');
});
bureauPresenceReapWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bureau-presence-reap', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bureau-presence-reap',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
// BullMQ's repeat scheduler does not accept a sub-minute cron pattern, so use
// `every` (milliseconds) for the 15s cadence per design doc §13.
const bureauPresenceReapQueue = new Queue('bureau-presence-reap', { connection: redis });
bureauPresenceReapQueue
  .upsertJobScheduler(
    'bureau-presence-reap-tick',
    { every: 15_000 },
    { name: 'tick', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bureau-presence-reap scheduler'));

// Bureau room-chat expiry (0187): hourly hard-delete of expired chat
// messages + husk rooms. Reads already filter expired rows; this is disk
// hygiene only, so an occasional missed tick is harmless.
const bureauChatExpiryWorker = new Worker<BureauChatExpiryJobData>(
  'bureau-chat-expiry',
  async (job: Job<BureauChatExpiryJobData>) => {
    await processBureauChatExpiryJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
bureauChatExpiryWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id, queue: 'bureau-chat-expiry' }, 'Job completed');
});
bureauChatExpiryWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bureau-chat-expiry', err }, 'Job failed');
  void recordWorkerError({
    queueName: 'bureau-chat-expiry',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const bureauChatExpiryQueue = new Queue('bureau-chat-expiry', { connection: redis });
bureauChatExpiryQueue
  .upsertJobScheduler(
    'bureau-chat-expiry-hourly',
    { pattern: '7 * * * *' }, // hh:07 — offset from other sweeps
    { name: 'sweep', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bureau-chat-expiry scheduler'));

// §10 Bureau summon fan-out — drains jobs enqueued by bureau-api when a
// summon has more than FANOUT_INLINE_LIMIT eligible recipients. Each job
// re-runs the access check, publishes summon_incoming + summon_progress
// frames, and emits the §14 Bolt event.
const bureauSummonFanoutWorker = new Worker<BureauSummonFanoutJobData>(
  'bureau-summon-fanout',
  async (job: Job<BureauSummonFanoutJobData>) => {
    await processBureauSummonFanoutJob(job, redis, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
bureauSummonFanoutWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bureau-summon-fanout' }, 'Job completed');
});
bureauSummonFanoutWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bureau-summon-fanout', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bureau-summon-fanout',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// §4.3 Bureau knock-timeout worker — drains delayed knock_id jobs enqueued
// from bureau-api when a visitor creates a knock. Concurrency matches the
// shared default; a single timed-out knock is a one-shot UPDATE + publish.
const bureauKnockTimeoutWorker = new Worker<BureauKnockTimeoutJobData>(
  'bureau-knock-timeout',
  async (job: Job<BureauKnockTimeoutJobData>) => {
    await processBureauKnockTimeoutJob(job, redis, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
bureauKnockTimeoutWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id, queue: 'bureau-knock-timeout' }, 'Job completed');
});
bureauKnockTimeoutWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bureau-knock-timeout', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bureau-knock-timeout',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Workstream 4 Bureau booking-activate worker — drains delayed jobs
// scheduled by bureau-api at booking-create time. Concurrency matches
// the shared default; each job is a single HSET + Bolt emit + publish.
const bureauBookingActivateWorker = new Worker<BureauBookingActivateJobData>(
  'bureau-booking-activate',
  async (job: Job<BureauBookingActivateJobData>) => {
    await processBureauBookingActivateJob(job, redis, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
bureauBookingActivateWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bureau-booking-activate' }, 'Job completed');
});
bureauBookingActivateWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bureau-booking-activate', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bureau-booking-activate',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Workstream 4 Bureau booking-release worker — runs at the booking's
// ends_at to clear the privacy override (if it is still ours).
const bureauBookingReleaseWorker = new Worker<BureauBookingReleaseJobData>(
  'bureau-booking-release',
  async (job: Job<BureauBookingReleaseJobData>) => {
    await processBureauBookingReleaseJob(job, redis, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
bureauBookingReleaseWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bureau-booking-release' }, 'Job completed');
});
bureauBookingReleaseWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bureau-booking-release', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bureau-booking-release',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Workstream 14 Bureau analytics rollup — daily cron at midnight UTC writes
// one row per floor per day to bureau_floor_analytics. Concurrency 1: this
// is a single per-org sweep, no benefit from parallelism, and it shares the
// midnight slot with bearing-snapshot (different tables, no contention).
const bureauAnalyticsRollupWorker = new Worker<BureauAnalyticsRollupJobData>(
  'bureau-analytics-rollup',
  async (job: Job<BureauAnalyticsRollupJobData>) => {
    await processBureauAnalyticsRollupJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
bureauAnalyticsRollupWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bureau-analytics-rollup' }, 'Job completed');
});
bureauAnalyticsRollupWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bureau-analytics-rollup', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bureau-analytics-rollup',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const bureauAnalyticsRollupQueue = new Queue('bureau-analytics-rollup', { connection: redis });
bureauAnalyticsRollupQueue
  .upsertJobScheduler(
    'bureau-analytics-rollup-daily',
    { pattern: '0 0 * * *' }, // midnight UTC — rolls up the day that just ended
    { name: 'daily', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bureau-analytics-rollup scheduler'));

// Book external-calendar sync sweep (every 15 minutes). Triggers the Book API
// internal sync engine for every connection due for a refresh. Offset to :09
// so it does not pile onto the on-the-hour / :00 / :05 jobs.
const bookCalendarSyncWorker = new Worker<BookCalendarSyncJobData>(
  'book-calendar-sync',
  async (job: Job<BookCalendarSyncJobData>) => {
    await processBookCalendarSyncJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
bookCalendarSyncWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'book-calendar-sync' }, 'Job completed');
});
bookCalendarSyncWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'book-calendar-sync', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'book-calendar-sync',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const bookCalendarSyncQueue = new Queue('book-calendar-sync', { connection: redis });
bookCalendarSyncQueue
  .upsertJobScheduler(
    'book-calendar-sync-tick',
    { pattern: '9,24,39,54 * * * *' }, // every 15 minutes, offset to :09
    { name: 'sweep', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register book-calendar-sync scheduler'));

// Bin AV-scan sweep (every minute). It is the only scan trigger today, so it
// runs frequently to keep upload->servable latency low. Claims pending
// bin_assets, scans the active version's bytes, and writes the verdict back so
// serving is gated until clean/skipped (Bin master §9.3).
const binAvScanWorker = new Worker<BinAvScanJobData>(
  'bin-av-scan',
  async (job: Job<BinAvScanJobData>) => {
    await processBinAvScanJob(job, env, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
binAvScanWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id, queue: 'bin-av-scan' }, 'Job completed');
});
binAvScanWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bin-av-scan', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'bin-av-scan',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const binAvScanQueue = new Queue('bin-av-scan', { connection: redis });
binAvScanQueue
  .upsertJobScheduler(
    'bin-av-scan-tick',
    { pattern: '* * * * *' }, // every minute — sole scan trigger, keep latency low
    { name: 'sweep', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bin-av-scan scheduler'));

// Bin media transcode sweep — generates web-friendly proxies + posters for
// clean media versions (Bay player polish). ffmpeg is CPU-heavy, so concurrency
// is 1 and each sweep claims a small batch.
const binTranscodeWorker = new Worker<BinTranscodeJobData>(
  'bin-transcode',
  async (job: Job<BinTranscodeJobData>) => {
    await processBinTranscodeJob(job, env, logger);
  },
  { ...connection, concurrency: 1 },
);
binTranscodeWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bin-transcode' }, 'Job completed');
});
binTranscodeWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bin-transcode', err }, 'Job failed');
  void recordWorkerError({
    queueName: 'bin-transcode',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const binTranscodeQueue = new Queue('bin-transcode', { connection: redis });
binTranscodeQueue
  .upsertJobScheduler(
    'bin-transcode-tick',
    { pattern: '* * * * *' }, // every minute — proxy lands shortly after the AV scan clears
    { name: 'sweep', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bin-transcode scheduler'));

// Bin model processing sweep — converts clean FBX/OBJ/STL/USD/... model assets
// to self-contained GLB proxies + probes them (Bay FBX 3D review). Conversion
// (assimpjs WASM + gltf-transform) is CPU/memory heavy, so concurrency is 1 and
// each sweep claims a small batch. Shares transcode_status with bin-transcode
// but claims disjoint rows by the model predicate.
const binModelProcessWorker = new Worker<BinModelProcessJobData>(
  'bin-model-process',
  async (job: Job<BinModelProcessJobData>) => {
    await processBinModelProcessJob(job, env, logger);
  },
  { ...connection, concurrency: 1 },
);
binModelProcessWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'bin-model-process' }, 'Job completed');
});
binModelProcessWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'bin-model-process', err }, 'Job failed');
  void recordWorkerError({
    queueName: 'bin-model-process',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const binModelProcessQueue = new Queue('bin-model-process', { connection: redis });
binModelProcessQueue
  .upsertJobScheduler(
    'bin-model-process-tick',
    { pattern: '* * * * *' }, // every minute — GLB proxy lands shortly after the AV scan clears
    { name: 'sweep', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register bin-model-process scheduler'));

// ---------------------------------------------------------------------------
// Blip telemetry workers (§17). Seven handlers: an enqueue-driven durable-write
// fan-in, two scheduled sweeps (partition provision, retention), a 30s
// window-watch eval tick, and three on-demand jobs (field index, JSONL export,
// timelapse). Capture offload/thumbnailing uses sharp; timelapse uses ffmpeg
// (already in the worker image).
// ---------------------------------------------------------------------------

// Blip durable-write fan-in (drain + capture offload + catalog upsert + insert).
const blipIngestWorker = new Worker<BlipIngestJobData>(
  BLIP_INGEST_QUEUE,
  async (job: Job<BlipIngestJobData>) => {
    await processBlipIngestJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
blipIngestWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id, queue: BLIP_INGEST_QUEUE }, 'Job completed');
});
blipIngestWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: BLIP_INGEST_QUEUE, err }, 'Job failed');
  void recordWorkerError({
    queueName: BLIP_INGEST_QUEUE,
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Blip partition provisioning (daily at 03:00 UTC — keeps the leading edge of
// monthly blip_entries partitions topped up).
const blipPartitionProvisionWorker = new Worker<BlipPartitionProvisionJobData>(
  'blip-partition-provision',
  async (job: Job<BlipPartitionProvisionJobData>) => {
    await processBlipPartitionProvisionJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
blipPartitionProvisionWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'blip-partition-provision' }, 'Job completed');
});
blipPartitionProvisionWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'blip-partition-provision', err }, 'Job failed');
  void recordWorkerError({
    queueName: 'blip-partition-provision',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const blipPartitionProvisionQueue = new Queue('blip-partition-provision', { connection: redis });
blipPartitionProvisionQueue
  .upsertJobScheduler(
    'blip-partition-provision-daily',
    { pattern: '0 3 * * *' }, // 03:00 UTC daily
    { name: 'provision', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register blip-partition-provision scheduler'));

// Blip retention sweep (daily at 03:15 UTC — partition drops + ranged deletes +
// paired capture-object GC).
const blipRetentionSweepWorker = new Worker<BlipRetentionSweepJobData>(
  'blip-retention-sweep',
  async (job: Job<BlipRetentionSweepJobData>) => {
    await processBlipRetentionSweepJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
blipRetentionSweepWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'blip-retention-sweep' }, 'Job completed');
});
blipRetentionSweepWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'blip-retention-sweep', err }, 'Job failed');
  void recordWorkerError({
    queueName: 'blip-retention-sweep',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const blipRetentionSweepQueue = new Queue('blip-retention-sweep', { connection: redis });
blipRetentionSweepQueue
  .upsertJobScheduler(
    'blip-retention-sweep-daily',
    { pattern: '15 3 * * *' }, // 03:15 UTC daily — after partition provision
    { name: 'sweep', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register blip-retention-sweep scheduler'));

// Blip window-watch eval tick (every 30s; cron can't express sub-minute, so use
// `every`).
const blipWatchEvalWorker = new Worker<BlipWatchEvalJobData>(
  'blip-watch-eval',
  async (job: Job<BlipWatchEvalJobData>) => {
    await processBlipWatchEvalJob(job, redis, logger);
  },
  { ...connection, concurrency: 1 },
);
blipWatchEvalWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id, queue: 'blip-watch-eval' }, 'Job completed');
});
blipWatchEvalWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'blip-watch-eval', err }, 'Job failed');
  void recordWorkerError({
    queueName: 'blip-watch-eval',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});
const blipWatchEvalQueue = new Queue('blip-watch-eval', { connection: redis });
blipWatchEvalQueue
  .upsertJobScheduler(
    'blip-watch-eval-tick',
    { every: 30_000 }, // every 30s per §12.1
    { name: 'tick', data: {} },
  )
  .catch((err) => logger.error({ err }, 'Failed to register blip-watch-eval scheduler'));

// Blip field-index creation (on-demand; CONCURRENTLY expression index).
const blipFieldIndexWorker = new Worker<BlipFieldIndexJobData>(
  BLIP_FIELD_INDEX_QUEUE,
  async (job: Job<BlipFieldIndexJobData>) => {
    await processBlipFieldIndexJob(job, logger);
  },
  { ...connection, concurrency: 1 }, // serialize heavy index builds
);
blipFieldIndexWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: BLIP_FIELD_INDEX_QUEUE }, 'Job completed');
});
blipFieldIndexWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: BLIP_FIELD_INDEX_QUEUE, err }, 'Job failed');
  void recordWorkerError({
    queueName: BLIP_FIELD_INDEX_QUEUE,
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Blip JSONL export / freeze (on-demand).
const blipExportJsonlWorker = new Worker<BlipExportJobData>(
  BLIP_EXPORT_JSONL_QUEUE,
  async (job: Job<BlipExportJobData>) => {
    await processBlipExportJsonlJob(job, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
blipExportJsonlWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: BLIP_EXPORT_JSONL_QUEUE }, 'Job completed');
});
blipExportJsonlWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: BLIP_EXPORT_JSONL_QUEUE, err }, 'Job failed');
  void recordWorkerError({
    queueName: BLIP_EXPORT_JSONL_QUEUE,
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Blip timelapse compilation (on-demand; ffmpeg). Concurrency 1 — CPU-heavy.
const blipTimelapseWorker = new Worker<BlipTimelapseJobData>(
  BLIP_TIMELAPSE_QUEUE,
  async (job: Job<BlipTimelapseJobData>) => {
    await processBlipTimelapseJob(job, logger);
  },
  { ...connection, concurrency: 1 },
);
blipTimelapseWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: BLIP_TIMELAPSE_QUEUE }, 'Job completed');
});
blipTimelapseWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: BLIP_TIMELAPSE_QUEUE, err }, 'Job failed');
  void recordWorkerError({
    queueName: BLIP_TIMELAPSE_QUEUE,
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Analytics worker (placeholder — processes analytics aggregation jobs)
const analyticsWorker = new Worker(
  'analytics',
  async (job: Job) => {
    logger.info(
      { jobId: job.id, data: job.data },
      'Processing analytics job (placeholder)',
    );
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);

analyticsWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: 'analytics' }, 'Job completed');
});

analyticsWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'analytics', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'analytics',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// Banter Feed fan-in worker — enqueue-driven (no cron). banter-api (and, from
// Phase 5, other apps) enqueue one job per surfacing event; the worker resolves
// concerned users (can_access + subscription) and upserts banter_feed_entries.
const banterFeedFaninWorker = new Worker<BanterFeedFaninJobData>(
  'banter-feed-fanin',
  async (job: Job<BanterFeedFaninJobData>) => {
    await processBanterFeedFaninJob(job, env, logger);
  },
  { ...connection, concurrency: env.WORKER_CONCURRENCY },
);
banterFeedFaninWorker.on('completed', (job) => {
  logger.debug({ jobId: job.id, queue: 'banter-feed-fanin' }, 'Job completed');
});
banterFeedFaninWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, queue: 'banter-feed-fanin', err }, 'Job failed');
  // Mirror into system_errors so the SuperUser Log Analysis tab
  // surfaces this failure. Best-effort, never throws.
  void recordWorkerError({
    queueName: 'banter-feed-fanin',
    jobId: job?.id,
    jobName: job?.name,
    err: err as Error,
  });
});

// §1 Wave 5 banter subs — pattern-match consumer.
// Subscribes to the banter:events Redis channel (the same fan-out used by
// the browser realtime bus), filters message.created events, evaluates
// every active subscription for the channel, and publishes
// banter.message.matched Bolt events on hits. Uses a SEPARATE Redis
// client because ioredis puts a client into subscriber mode exclusively.
// The rate-limiter continues to share the main `redis` client.
const banterPatternMatchSubscriber = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
const banterPatternMatchConsumer = await startBanterPatternMatchConsumer(
  banterPatternMatchSubscriber,
  redis,
  logger,
  {
    apiInternalUrl: env.API_INTERNAL_URL,
    internalServiceSecret: env.INTERNAL_SERVICE_SECRET,
  },
);

// §13 Wave 4 scheduled banter — startup reconciler.
// Re-enqueue any pending scheduled-message rows whose BullMQ job may have been
// lost (e.g. Redis was flushed). Safe to call because BullMQ dedups by jobId.
const banterScheduledPostQueue = new Queue('banter-scheduled-post', { connection: redis });
reconcileScheduledPosts(
  async (jobId, data, delayMs) => {
    await banterScheduledPostQueue.add('scheduled-post', data, {
      jobId,
      delay: delayMs,
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  },
  logger,
).catch((err) => {
  logger.error({ err }, 'banter-scheduled-post: startup reconciler failed');
});

// Collect all workers for graceful shutdown
const workers = [
  emailWorker,
  notificationWorker,
  sprintCloseWorker,
  exportWorker,
  banterNotificationWorker,
  banterRetentionWorker,
  banterScheduledPostWorker,
  helpdeskTaskCreateWorker,
  beaconVectorSyncWorker,
  beaconExpirySweepWorker,
  livekitIpDriftWorker,
  turnCertExpiryWorker,
  bearingSnapshotWorker,
  bearingRecomputeWorker,
  bearingDigestWorker,
  bearingWatcherNotifyWorker,
  boltExecuteWorker,
  boltScheduleTickWorker,
  blastSendWorker,
  bondStaleDealsWorker,
  billPdfGenerateWorker,
  billEmailSendWorker,
  billOverdueReminderWorker,
  blankConfirmationEmailWorker,
  blankFileProcessWorker,
  benchReportDeliverWorker,
  benchMvRefreshWorker,
  briefEmbedWorker,
  briefSnapshotWorker,
  briefExportWorker,
  briefCleanupWorker,
  helpdeskSlaMonitorWorker,
  boardThumbnailWorker,
  boltExecutionCleanupWorker,
  bondBulkScoreWorker,
  helpdeskEmailNotifyWorker,
  // §20 Wave 5 webhooks
  agentWebhookDispatchWorker,
  agentWebhookDlqWorker,
  slackImportWorker,
  // Phase 0 task Links title fetch
  taskLinkTitleFetchWorker,
  // §13 Bureau presence reaper
  bureauPresenceReapWorker,
  // §10 Bureau summon fan-out
  bureauSummonFanoutWorker,
  // §4.3 Bureau knock timeout
  bureauKnockTimeoutWorker,
  // Workstream 4 Bureau booking lifecycle (activate at starts_at, release at ends_at)
  bureauBookingActivateWorker,
  bureauBookingReleaseWorker,
  // Workstream 14 Bureau analytics rollup
  bureauAnalyticsRollupWorker,
  // Book task #63 external-calendar sync sweep
  bookCalendarSyncWorker,
  // Banter Feed fan-in
  banterFeedFaninWorker,
  // Bin AV-scan sweep
  binAvScanWorker,
  // Bin media transcode
  binTranscodeWorker,
  // Bin model processing (Bay FBX 3D review)
  binModelProcessWorker,
  // Blip telemetry (§17)
  blipIngestWorker,
  blipPartitionProvisionWorker,
  blipRetentionSweepWorker,
  blipWatchEvalWorker,
  blipFieldIndexWorker,
  blipExportJsonlWorker,
  blipTimelapseWorker,
  analyticsWorker,
];

logger.info(
  {
    queues: [
      'email',
      'notifications',
      'sprint-close',
      'export',
      'banter-notifications',
      'banter-retention',
      'banter-transcription',
      'banter-scheduled-post',
      'helpdesk-task-create',
      'beacon-vector-sync',
      'beacon-expiry-sweep',
      'bearing-snapshot',
      'bearing-recompute',
      'bearing-digest',
      'bearing-watcher-notify',
      'bolt-execute',
      'bolt-schedule',
      'blast-send',
      'bond-stale-deals',
      'bill-pdf-generate',
      'bill-email-send',
      'bill-overdue-reminder',
      'blank-confirmation-email',
      'blank-file-process',
      'bench-report-deliver',
      'bench-mv-refresh',
      'brief-embed',
      'brief-snapshot',
      'brief-export',
      'brief-cleanup',
      'helpdesk-sla-monitor',
      'board-thumbnail',
      'bolt-execution-cleanup',
      'bond-bulk-score',
      'helpdesk-email-notify',
      // §20 Wave 5 webhooks
      'agent-webhook-dispatch',
      'agent-webhook-dlq',
      'slack-import',
      // Phase 0 task Links title fetch
      'task-link-title-fetch',
      // §13 Bureau presence reaper
      'bureau-presence-reap',
      // §10 Bureau summon fan-out
      'bureau-summon-fanout',
      // §4.3 Bureau knock timeout
      'bureau-knock-timeout',
      // Workstream 4 Bureau booking lifecycle
      'bureau-booking-activate',
      'bureau-booking-release',
      // Workstream 14 Bureau analytics rollup
      'bureau-analytics-rollup',
      // Book task #63 external-calendar sync sweep
      'book-calendar-sync',
      // Banter Feed fan-in
      'banter-feed-fanin',
      // Bin AV-scan sweep
      'bin-av-scan',
      // Bin media transcode
      'bin-transcode',
      // Bin model processing (Bay FBX 3D review)
      'bin-model-process',
      // Blip telemetry (§17)
      BLIP_INGEST_QUEUE,
      'blip-partition-provision',
      'blip-retention-sweep',
      'blip-watch-eval',
      BLIP_FIELD_INDEX_QUEUE,
      BLIP_EXPORT_JSONL_QUEUE,
      BLIP_TIMELAPSE_QUEUE,
      'analytics',
      // LiveKit advertised-address drift watchdog (hourly)
      'livekit-ip-drift',
      // TURN-TLS certificate expiry watchdog (daily)
      'turn-cert-expiry',
    ],
  },
  'All workers started',
);

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Received shutdown signal, closing workers...');

  // §1 Wave 5 banter subs - stop the pattern-match consumer first so no new
  // matches fire during the queue drain.
  try {
    await banterPatternMatchConsumer.stop();
    banterPatternMatchSubscriber.disconnect();
  } catch (err) {
    logger.warn({ err }, 'banter-pattern-match: shutdown stop failed');
  }

  await Promise.all(workers.map((w) => w.close()));
  await closeDb();
  redis.disconnect();

  logger.info('All workers closed. Exiting.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
