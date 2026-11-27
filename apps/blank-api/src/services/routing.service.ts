/**
 * Conditional logic routing service for Blank form submissions.
 *
 * After a submission is persisted, this service checks the form's
 * routing_config and conditionally routes to:
 *   - Bond contact upsert (bond-api POST /v1/internal/contacts), attributed
 *     to the form's creator
 *   - Helpdesk ticket creation (helpdesk-api POST /helpdesk/internal/tickets),
 *     requested by the person who submitted the form
 *
 * Both are the owning apps' internal routes behind the shared internal-secret
 * guard, with bodies typed by the shared Zod contracts in @bigbluebam/shared
 * (#305). These used to POST the session-authenticated /v1/contacts and
 * /v1/tickets with the internal secret, which those routes ignore, so every
 * routing action failed.
 *
 * Routing is fire-and-forget; failures are logged but do not block the
 * submission response. Each rule has a condition and an action.
 *
 * routing_config structure:
 * {
 *   rules: [
 *     {
 *       condition: { field: "interest", op: "equals", value: "sales" },
 *       action: { type: "bond_contact", field_map: { email: "email", first_name: "name" } }
 *     },
 *     {
 *       condition: { field: "type", op: "equals", value: "support" },
 *       action: { type: "helpdesk_ticket", field_map: { subject: "subject", description: "details" } }
 *     }
 *   ]
 * }
 */

import type { BondInternalContactUpsert, HelpdeskInternalTicketCreate } from '@bigbluebam/shared';
import { env } from '../env.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoutingCondition {
  field: string;
  op: 'equals' | 'not_equals' | 'contains' | 'is_set' | 'is_not_set' | 'always';
  value?: unknown;
}

interface RoutingAction {
  type: 'bond_contact' | 'helpdesk_ticket';
  field_map: Record<string, string>;
}

interface RoutingRule {
  condition: RoutingCondition;
  action: RoutingAction;
}

interface RoutingConfig {
  rules: RoutingRule[];
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

function evaluateCondition(
  condition: RoutingCondition,
  responseData: Record<string, unknown>,
): boolean {
  if (condition.op === 'always') return true;

  const fieldValue = responseData[condition.field];

  switch (condition.op) {
    case 'equals':
      return String(fieldValue) === String(condition.value);
    case 'not_equals':
      return String(fieldValue) !== String(condition.value);
    case 'contains':
      return typeof fieldValue === 'string' &&
        fieldValue.toLowerCase().includes(String(condition.value).toLowerCase());
    case 'is_set':
      return fieldValue !== undefined && fieldValue !== null && fieldValue !== '';
    case 'is_not_set':
      return fieldValue === undefined || fieldValue === null || fieldValue === '';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

function mapFields(
  fieldMap: Record<string, string>,
  responseData: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [targetField, sourceField] of Object.entries(fieldMap)) {
    const value = responseData[sourceField];
    if (value !== undefined && value !== null) {
      result[targetField] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal HTTP helpers
// ---------------------------------------------------------------------------

/** Who and what a routed submission is about. */
export interface RoutingContext {
  orgId: string;
  submissionId: string;
  /** The form's creator: the Bam user a routed Bond contact is attributed to. */
  formOwnerUserId: string | null;
  /** The submitter's email when the form collected one (login or an email field). */
  submitterEmail: string | null;
}

async function internalPost(baseUrl: string, path: string, body: unknown): Promise<void> {
  if (!env.INTERNAL_SERVICE_SECRET) {
    throw new Error('INTERNAL_SERVICE_SECRET is not configured; cannot reach the internal route');
  }
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Service-Secret': env.INTERNAL_SERVICE_SECRET,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Internal API ${path} returned ${response.status}: ${text.slice(0, 200)}`);
  }
}

function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

// ---------------------------------------------------------------------------
// Execute routing actions
// ---------------------------------------------------------------------------

/** The Bond body for a routed submission, or why there is none. Exported for tests. */
export function bondContactBody(
  mapped: Record<string, unknown>,
  ctx: RoutingContext,
): BondInternalContactUpsert | { skip: string } {
  if (!ctx.formOwnerUserId) return { skip: 'the form has no owner to attribute the contact to' };
  const email = str(mapped.email) ?? ctx.submitterEmail ?? undefined;
  if (!email) return { skip: 'no email mapped or collected' };
  return {
    org_id: ctx.orgId,
    acting_user_id: ctx.formOwnerUserId,
    email,
    first_name: str(mapped.first_name),
    last_name: str(mapped.last_name),
    phone: str(mapped.phone),
    title: str(mapped.title),
    lead_source: str(mapped.lead_source) ?? 'blank_form',
  };
}

/** The Helpdesk body for a routed submission, or why there is none. Exported for tests. */
export function helpdeskTicketBody(
  mapped: Record<string, unknown>,
  ctx: RoutingContext,
): HelpdeskInternalTicketCreate | { skip: string } {
  const email = str(mapped.email) ?? ctx.submitterEmail ?? undefined;
  if (!email) return { skip: 'no requester email mapped or collected' };
  const subject = str(mapped.subject) ?? 'Form submission';
  // `body` is the historical field_map key for the ticket text; `description` is the API's name.
  const description = str(mapped.description) ?? str(mapped.body);
  if (!description) return { skip: 'no description mapped' };
  const priority = str(mapped.priority);
  return {
    org_id: ctx.orgId,
    requester_email: email,
    requester_name: str(mapped.name),
    subject: subject.slice(0, 500),
    description,
    priority: priority === 'low' || priority === 'high' ? priority : 'medium',
    category: str(mapped.category),
  };
}

// ---------------------------------------------------------------------------
// Main routing function
// ---------------------------------------------------------------------------

/**
 * Process routing rules for a submission. Call this after the submission
 * is persisted. Errors are caught and logged, never thrown.
 */
export async function processRoutingRules(
  routingConfig: unknown,
  responseData: Record<string, unknown>,
  ctx: RoutingContext,
  logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): Promise<void> {
  const { submissionId } = ctx;
  if (!routingConfig || typeof routingConfig !== 'object') return;

  const config = routingConfig as RoutingConfig;
  if (!Array.isArray(config.rules) || config.rules.length === 0) return;

  for (const rule of config.rules) {
    try {
      if (!rule.condition || !rule.action) continue;

      const match = evaluateCondition(rule.condition, responseData);
      if (!match) continue;

      const mapped = mapFields(rule.action.field_map ?? {}, responseData);

      switch (rule.action.type) {
        case 'bond_contact': {
          const body = bondContactBody(mapped, ctx);
          if ('skip' in body) {
            logger.warn({ submissionId, action: 'bond_contact', reason: body.skip }, 'blank-routing: action skipped');
            break;
          }
          await internalPost(env.BOND_API_INTERNAL_URL, '/v1/internal/contacts', body);
          logger.info(
            { submissionId, action: 'bond_contact' },
            'blank-routing: created Bond contact from submission',
          );
          break;
        }

        case 'helpdesk_ticket': {
          const body = helpdeskTicketBody(mapped, ctx);
          if ('skip' in body) {
            logger.warn({ submissionId, action: 'helpdesk_ticket', reason: body.skip }, 'blank-routing: action skipped');
            break;
          }
          await internalPost(env.HELPDESK_API_URL, '/helpdesk/internal/tickets', body);
          logger.info(
            { submissionId, action: 'helpdesk_ticket' },
            'blank-routing: created Helpdesk ticket from submission',
          );
          break;
        }

        default:
          logger.warn(
            { submissionId, actionType: rule.action.type },
            'blank-routing: unknown action type, skipping',
          );
      }
    } catch (err) {
      logger.error(
        {
          submissionId,
          actionType: rule.action?.type,
          err: err instanceof Error ? err.message : String(err),
        },
        'blank-routing: action failed',
      );
    }
  }
}
