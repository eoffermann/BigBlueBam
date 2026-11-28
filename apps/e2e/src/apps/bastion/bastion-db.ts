import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Backend read-back for the Bastion stories: psql through `docker compose exec postgres` (the same
// route global-setup uses for the api CLI). Every query a story writes filters on organization_id
// (or org_id on the platform tables), and only values that pass id() are ever put into SQL.

export const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..', '..');
export const GILLIGAN_ORG_SLUG = 'gilligan-travel-ltd';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One psql query through the compose postgres container; returns the unaligned, tuples-only text. */
export function psql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      process.env.E2E_PG_USER || 'bigbluebam',
      '-d',
      process.env.E2E_PG_DB || 'bigbluebam',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** Only ids that look like ids are ever put into SQL. */
export function id(v: string | null | undefined): string {
  if (!v || !UUID_RE.test(v)) throw new Error(`not an id: ${String(v)}`);
  return v;
}

/** The GILLIGAN organization's id. */
export function gilliganOrgId(): string {
  return id(psql(`SELECT id FROM organizations WHERE slug = '${GILLIGAN_ORG_SLUG}'`));
}

/** A user's id by email (lower-cased; the email must be a plain address). */
export function userIdByEmail(email: string): string {
  if (!/^[a-z0-9._+-]+@[a-z0-9.-]+$/i.test(email)) throw new Error(`not an email: ${email}`);
  return id(psql(`SELECT id FROM users WHERE lower(email) = '${email.toLowerCase()}'`));
}

/**
 * The bastion_outbox row for one Bolt event, by the idempotency key its publisher uses
 * (`event:<event_type>:<subject id>`), as "status|event_type|actor_id", or '' when absent.
 */
export function outboxEvent(orgId: string, eventType: string, subjectId: string): string {
  if (!/^[a-z_.]+$/.test(eventType)) throw new Error(`not an event type: ${eventType}`);
  return psql(
    `SELECT status || '|' || (payload->>'event_type') || '|' || coalesce(payload->>'actor_id', '')
       FROM bastion_outbox
      WHERE organization_id = '${id(orgId)}' AND kind = 'bolt_event'
        AND idempotency_key = 'event:${eventType}:${id(subjectId)}'`,
  );
}

/** How many bastion_audit_log rows record `action` on one subject, optionally with one details value. */
export function auditCount(orgId: string, action: string, subjectId: string, detail?: { key: string; value: string }): number {
  const word = /^[a-z_.]+$/;
  if (!word.test(action)) throw new Error(`not an action: ${action}`);
  if (detail && !(word.test(detail.key) && word.test(detail.value))) throw new Error(`not a detail: ${JSON.stringify(detail)}`);
  const filter = detail ? ` AND details->>'${detail.key}' = '${detail.value}'` : '';
  return Number(
    psql(
      `SELECT count(*) FROM bastion_audit_log
        WHERE organization_id = '${id(orgId)}' AND action = '${action}' AND subject_id = '${id(subjectId)}'${filter}`,
    ),
  );
}
