/**
 * Redis PubSub fan-out for Blip live tail (Blip §8). The ingest edge publishes
 * every redacted entry to `blip:tail:<tracked_app_id>:<report_type>` before the
 * durable write, so the tail is genuinely live and not gated on the write loop.
 * The WS gateway (routes/ws.routes.ts) holds client subscriptions, each with a
 * compiled filter, and filters/projects server-side.
 *
 * Fire-and-forget: a Redis failure must never block the ingest hot path.
 */
import type Redis from 'ioredis';

export type TailEntry = {
  seq: string | null; // bigint serialized; null on the pre-write tail copy
  id?: string;
  received_at: string;
  tracked_app_id: string;
  report_type: string;
  level: string | null;
  session_id: string | null;
  app_version: string | null;
  platform: string | null;
  elapsed_ms: number | null;
  capture_count: number;
  // Full redacted payload. screen_captures are stripped to lightweight
  // descriptors on the tail copy (Blip §4.1 step 10).
  payload: Record<string, unknown>;
};

export function tailChannel(trackedAppId: string, reportType: string): string {
  return `blip:tail:${trackedAppId}:${reportType}`;
}

/** Publish a redacted entry to its tail channel. Never throws. */
export function publishTail(redis: Redis, entry: TailEntry): void {
  try {
    void redis.publish(tailChannel(entry.tracked_app_id, entry.report_type), JSON.stringify(entry));
  } catch {
    // tail is best-effort; the durable store is the source of truth.
  }
}
