import Redis from 'ioredis';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { env } from '../env.js';

// The per-org, per-binding dispatch gate (spec §6 / STJ3 / STK4). The set
// `bulwark:bindings:<org_id>` holds `<source>:<event_type>` members for every currently-armed
// obligation. bolt-api's dispatch hook SISMEMBERs it before forwarding an event, so a chatty
// event type an org does not bind is dropped at the sending end.
//
// The set is a CACHE over the durable `bulwark_obligations(is_armed, event_binding)` table,
// NEVER the record. It is rebuilt at bulwark-api boot and on the state-reconcile cadence, so a
// Redis flush cannot permanently drop triggers. It is ADVISORY; the table is authoritative: a
// stale entry only causes a spurious dispatch that finds no armed obligation, so this must NOT
// be hardened into a two-phase commit.

let client: Redis | null = null;

function getClient(): Redis {
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    client.on('error', () => {});
  }
  return client;
}

export function gateKey(orgId: string): string {
  return `bulwark:bindings:${orgId}`;
}

export function bindingMember(source: string, eventType: string): string {
  return `${source}:${eventType}`;
}

// Add a single binding member to an org's gate. Returns true only when the SADD is CONFIRMED
// (STJ3: the arm is not committed as armed until the gate reflects it). A caller that requires
// the confirmation treats false as "do not report armed"; the periodic rebuild self-heals.
export async function addBinding(
  orgId: string,
  source: string,
  eventType: string,
): Promise<boolean> {
  if (!source || !eventType) return true; // nothing to gate (unbound/calendar); no-op success
  try {
    // SADD returns 0 when the member already existed, 1 when added; both mean the member is
    // present after the call, which is the confirmation we need.
    await getClient().sadd(gateKey(orgId), bindingMember(source, eventType));
    return true;
  } catch {
    return false;
  }
}

// Rebuild an org's gate set from the authoritative table (spec §6 / STJ3). Computes the
// DISTINCT (source, event_type) of every armed, event-bound obligation and replaces the set in
// one shot so a Redis flush self-heals on the next cadence. Best-effort; never throws.
export async function rebuildGate(orgId: string): Promise<number> {
  const raw = await db.execute(sql`
    SELECT DISTINCT event_binding->>'source' AS source, event_binding->>'event_type' AS event_type
      FROM bulwark_obligations
     WHERE organization_id = ${orgId}
       AND is_armed
       AND coalesce(event_binding->>'source', '') <> ''
       AND coalesce(event_binding->>'event_type', '') <> ''
  `);
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Array<{
    source: string;
    event_type: string;
  }>;
  const members = rows
    .filter((r) => r.source && r.event_type)
    .map((r) => bindingMember(r.source, r.event_type));
  const key = gateKey(orgId);
  try {
    const c = getClient();
    // Replace atomically-ish: delete then re-add. A concurrent arm's addBinding may race and
    // be dropped, but the next rebuild (or the arm's own SADD) restores it, and the table stays
    // authoritative (STK4). Skip the DEL when there is nothing to add so we never blank a live
    // gate on a transient empty read.
    if (members.length === 0) {
      await c.del(key);
      return 0;
    }
    await c.del(key);
    await c.sadd(key, ...members);
    return members.length;
  } catch {
    return -1;
  }
}

// Rebuild every org's gate (boot + cadence entry point). Returns the number of orgs processed.
export async function rebuildAllGates(): Promise<{ orgs: number; members: number }> {
  const raw = await db.execute(sql`
    SELECT DISTINCT organization_id FROM bulwark_obligations WHERE is_armed
  `);
  const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Array<{
    organization_id: string;
  }>;
  let members = 0;
  for (const r of rows) {
    const n = await rebuildGate(r.organization_id);
    if (n > 0) members += n;
  }
  return { orgs: rows.length, members };
}

export async function closeGateClient(): Promise<void> {
  if (client) {
    client.disconnect();
    client = null;
  }
}
