/**
 * Blip live-tail WebSocket gateway (Blip §8). A browser subscribes to one
 * (tracked_app, report_type); the gateway loads a backfill page from the durable
 * store, then streams every redacted entry the ingest edge publishes to
 * `blip:tail:<tracked_app_id>:<report_type>` (Redis pub/sub), evaluating the
 * subscriber's compiled filter server-side and pushing only matches.
 *
 * Protocol (client → server):
 *   { "type": "subscribe", "tracked_app_id, "report_type", "filter"?, "since_seq"? }
 * Server → client:
 *   { "type": "backfill", "entries": [...] }   // recent matching, seq asc
 *   { "type": "entry", "entry": {...} }         // live, as they arrive
 *   { "type": "error", "code", "message" }
 *   { "type": "ping" }                          // 25s keepalive
 *
 * Read-only fanout: all writes go through the ingest edge + authenticated REST.
 * TODO(backpressure): per-socket delivery ceiling + `sampling` notices (§8.3).
 */
import type { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../env.js';
import { requireAuth } from '../plugins/auth.js';
import { db } from '../db/index.js';
import { blipTrackedApps } from '../db/schema/index.js';
import { backfillEntries } from '../services/entry.service.js';
import { tailChannel } from '../lib/broadcast.js';
import { evalPredicate, type Predicate } from '../lib/predicate.js';

const subscribeSchema = z.object({
  type: z.literal('subscribe'),
  tracked_app_id: z.string().uuid(),
  report_type: z.string().min(1),
  filter: z.any().optional(),
  since_seq: z.union([z.string(), z.number()]).optional(),
});

const PING_INTERVAL_MS = 25_000;

export default async function wsRoutes(fastify: FastifyInstance) {
  fastify.get('/ws', { websocket: true, preHandler: [requireAuth] }, (socket, request) => {
    const user = request.user!;
    const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    let currentChannel: string | null = null;
    let currentFilter: Predicate | undefined;
    let closed = false;

    const send = (payload: unknown): void => {
      if (closed) return;
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        /* socket mid-close; close handler owns cleanup */
      }
    };

    // Each published entry is a redacted TailEntry; gate it through the
    // subscriber's compiled filter before pushing.
    subscriber.on('message', (_channel: string, message: string) => {
      if (closed) return;
      let entry: Record<string, unknown> & { payload?: Record<string, unknown> };
      try {
        entry = JSON.parse(message);
      } catch {
        return;
      }
      try {
        const rec = { ...entry, payload: entry.payload ?? {} } as unknown as Parameters<
          typeof evalPredicate
        >[1];
        if (evalPredicate(currentFilter, rec)) send({ type: 'entry', entry });
      } catch {
        /* a malformed predicate must never kill the stream */
      }
    });

    const pingTimer = setInterval(() => send({ type: 'ping' }), PING_INTERVAL_MS);

    socket.on('message', (raw: Buffer | string) => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          send({ type: 'error', code: 'BAD_FRAME', message: 'Frames must be JSON' });
          return;
        }
        const sub = subscribeSchema.safeParse(parsed);
        if (!sub.success) return; // tolerate unknown frames (e.g. client pong)
        const { tracked_app_id, report_type, filter, since_seq } = sub.data;

        // Same org gate the REST routes use: the app must be in the caller's org.
        const appRows = await db
          .select({ id: blipTrackedApps.id })
          .from(blipTrackedApps)
          .where(and(eq(blipTrackedApps.id, tracked_app_id), eq(blipTrackedApps.org_id, user.active_org_id)))
          .limit(1);
        if (appRows.length === 0) {
          send({ type: 'error', code: 'FORBIDDEN', message: 'No access to this tracked app' });
          return;
        }

        currentFilter = filter as Predicate | undefined;

        // Backfill the most recent matching page (or everything since since_seq).
        try {
          const entries = await backfillEntries({
            orgId: user.active_org_id,
            trackedAppId: tracked_app_id,
            reportType: report_type,
            filter: currentFilter,
            sinceSeq: since_seq != null ? String(since_seq) : undefined,
          });
          send({ type: 'backfill', entries });
        } catch (err) {
          request.log.warn({ err, tracked_app_id, report_type }, 'blip ws: backfill failed');
          send({ type: 'error', code: 'BACKFILL_FAILED', message: 'Could not load backfill' });
        }

        // Subscribe to the live tail channel for this (app, report_type).
        const channel = tailChannel(tracked_app_id, report_type);
        try {
          if (subscriber.status === 'wait') await subscriber.connect();
          if (currentChannel && currentChannel !== channel) {
            await subscriber.unsubscribe(currentChannel);
          }
          await subscriber.subscribe(channel);
          currentChannel = channel;
        } catch (err) {
          request.log.warn({ err, channel }, 'blip ws: subscribe failed');
          send({ type: 'error', code: 'SUBSCRIBE_FAILED', message: 'Try again' });
        }
      })();
    });

    socket.on('close', () => {
      closed = true;
      clearInterval(pingTimer);
      subscriber.disconnect();
    });
    socket.on('error', () => {
      closed = true;
      clearInterval(pingTimer);
      subscriber.disconnect();
    });
  });
}
