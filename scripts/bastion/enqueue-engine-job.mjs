#!/usr/bin/env node
/**
 * Enqueue one Bastion engine job onto its BullMQ queue so the running WORKER processes it, exactly
 * as its repeatable schedule would (e.g. bastion-ledger-seal, normally daily at 23:55 UTC).
 * Used for live rehearsals where waiting for the schedule is impractical.
 *
 * Runs inside the worker container (it has bullmq and REDIS_URL):
 *   docker compose exec -T -e QUEUE=bastion-ledger-seal -e ORG_ID=<uuid> worker \
 *     node --input-type=module - < scripts/bastion/enqueue-engine-job.mjs
 *
 * QUEUE   the queue name (required)
 * ORG_ID  optional organization_id for the job data (omitted: every org)
 */
import { createRequire } from 'node:module';

const require = createRequire('/app/package.json');
const { Queue, QueueEvents } = require('bullmq');

const t0 = Date.now();
const log = (m) => console.log(`[enqueue +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const queueName = process.env.QUEUE;
if (!queueName) {
  console.error('QUEUE is required');
  process.exit(2);
}
const url = new URL(process.env.REDIS_URL);
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  password: url.password ? decodeURIComponent(url.password) : undefined,
  username: url.username ? decodeURIComponent(url.username) : undefined,
};
const data = process.env.ORG_ID ? { organization_id: process.env.ORG_ID } : {};

const queue = new Queue(queueName, { connection });
const events = new QueueEvents(queueName, { connection });
await events.waitUntilReady();
const job = await queue.add(`rehearsal-${Date.now()}`, data, { removeOnComplete: 100, removeOnFail: 100 });
log(`enqueued ${queueName} job ${job.id} ${JSON.stringify(data)}; waiting up to 120 s for the worker...`);
try {
  const result = await job.waitUntilFinished(events, 120_000);
  log(`worker finished it: ${JSON.stringify(result)}`);
} catch (err) {
  log(`not finished: ${err.message}`);
  process.exitCode = 1;
} finally {
  await events.close();
  await queue.close();
}
