import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { BurnWorkRefType } from '@bigbluebam/shared';
import { env } from '../env.js';
import * as expenseService from '../services/expense.service.js';
import {
  runBurnPrecheck,
  type BurnPrecheckConfig,
  type BurnPrecheckResult,
} from './burn-precheck.client.js';

/**
 * The `burnPrecheck` preHandler (Burn spec 5.2, 9.2).
 *
 * Registered on the three money-out moments in bill-api. The fourth hook point is the
 * bill-recurring-generate worker job, which is not a Fastify route and consults the
 * breaker once per JOB rather than once per schedule -- see isGateWorthCalling().
 *
 *   | Hook                        | Class          | Blocking eligible |
 *   | POST   /expenses            | bill.expense   | yes               |
 *   | PATCH  /expenses/:id        | bill.expense   | yes, on amount or project_id change |
 *   | POST   /expenses/:id/approve| bill.expense   | yes -- approval is the real commitment |
 *
 * Placement inside the preHandler array matters. The gate runs AFTER
 * requireCan('bill.expense.*') and AFTER requireScope, because a caller who is not allowed
 * to create an expense at all must get a 403 from the permission layer rather than a
 * financial verdict; the gate is not an oracle and must not answer questions the caller
 * had no business asking (spec 12.1, "The gate is not an oracle").
 *
 * ── FAIL-OPEN IS THE DEFAULT AND IT IS NOT SILENT ───────────────────────────────────
 *
 * This hook can only ever produce one non-2xx: HTTP 409 on an ENFORCED deny. Every failure
 * of the gate itself -- unset URL, open breaker, timeout, 5xx, Redis down -- calls
 * `done()` and lets the write proceed, having stamped `request.burnGate` so the route
 * handler can persist a `burn_gate` marker on the created row. That marker is what lets
 * burn-variance-sweep raise `ungated_charge` against real rows on recovery instead of
 * against a bare counter (spec 6.1).
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by burnPrecheck. Present on every gated route, including the fail-open paths. */
    burnGate?: BurnPrecheckResult;
  }
}

export function burnPrecheckConfig(): BurnPrecheckConfig {
  return {
    baseUrl: env.BURN_API_INTERNAL_URL,
    timeoutMs: env.BURN_PRECHECK_TIMEOUT_MS,
    breakerThreshold: env.BURN_PRECHECK_BREAKER_THRESHOLD,
    breakerProbeMs: env.BURN_PRECHECK_BREAKER_PROBE_MS,
    internalSecret: env.INTERNAL_SERVICE_SECRET,
  };
}

/** What the gate needs to know about the charge, per hook point. */
interface GatedCharge {
  work_ref_type: BurnWorkRefType;
  work_ref_id: string | null;
  project_id: string | null;
  proposed_amount: number;
  currency: string;
  title: string | null;
  description: string | null;
  occurred_at: string | null;
}

type ChargeExtractor = (
  request: FastifyRequest,
) => Promise<GatedCharge | null> | GatedCharge | null;

/** POST /expenses. The pre-transaction case: the row does not exist yet, so work_ref_id is null. */
export const expenseCreateCharge: ChargeExtractor = (request) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const amount = typeof body.amount === 'number' ? body.amount : null;
  if (amount === null) return null; // Zod in the handler will reject it; do not gate garbage.
  return {
    work_ref_type: 'bill.expense',
    work_ref_id: null,
    project_id: typeof body.project_id === 'string' ? body.project_id : null,
    proposed_amount: amount,
    currency: typeof body.currency === 'string' ? body.currency : 'USD',
    title: typeof body.vendor === 'string' ? body.vendor : null,
    description: typeof body.description === 'string' ? body.description : null,
    occurred_at: typeof body.expense_date === 'string' ? body.expense_date : null,
  };
};

/**
 * PATCH /expenses/:id. Gated ONLY when `amount` or `project_id` actually changes (spec 5.2).
 * A description or receipt edit is not a money commitment and must not cost a round trip,
 * nor a coverage-counter increment that would dilute the gate-coverage figure with calls
 * the gate was never meant to make.
 */
export const expenseUpdateCharge: ChargeExtractor = async (request) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const touchesAmount = Object.hasOwn(body, 'amount');
  const touchesProject = Object.hasOwn(body, 'project_id');
  if (!touchesAmount && !touchesProject) return null;

  const { id } = request.params as { id: string };
  let existing: Awaited<ReturnType<typeof expenseService.getExpense>> | null = null;
  try {
    existing = await expenseService.getExpense(id, request.user!.org_id);
  } catch {
    // Not found / not ours. Let the handler produce the real 404 rather than gating a
    // charge that does not exist -- and note the gate would otherwise leak existence.
    return null;
  }

  const nextAmount = touchesAmount && typeof body.amount === 'number' ? body.amount : existing.amount;
  const nextProject = touchesProject
    ? typeof body.project_id === 'string'
      ? body.project_id
      : null
    : existing.project_id;

  if (nextAmount === existing.amount && nextProject === existing.project_id) return null;

  return {
    work_ref_type: 'bill.expense',
    work_ref_id: existing.id,
    project_id: nextProject,
    proposed_amount: nextAmount,
    currency: existing.currency,
    title: existing.vendor,
    description: typeof body.description === 'string' ? body.description : existing.description,
    occurred_at: existing.expense_date,
  };
};

/**
 * POST /expenses/:id/approve. Spec 5.2 calls approval "the real money commitment", so this
 * is gated even though creation already was: an expense can be created below any threshold
 * and edited, and approval is the moment the firm actually owes it.
 */
export const expenseApproveCharge: ChargeExtractor = async (request) => {
  const { id } = request.params as { id: string };
  try {
    const existing = await expenseService.getExpense(id, request.user!.org_id);
    return {
      work_ref_type: 'bill.expense',
      work_ref_id: existing.id,
      project_id: existing.project_id,
      proposed_amount: existing.amount,
      currency: existing.currency,
      title: existing.vendor,
      description: existing.description,
      occurred_at: existing.expense_date,
    };
  } catch {
    return null;
  }
};

/**
 * Build the preHandler for one hook point.
 *
 * NOTE the try/catch around the whole body. Even though runBurnPrecheck is written never to
 * throw, a bug in the extractor (a DB blip inside getExpense, say) must not become a 500 on
 * a money route. The gate is a read-only advisory sitting in front of a write; if any part
 * of it misbehaves the write still happens.
 */
export function burnPrecheck(extract: ChargeExtractor): preHandlerHookHandler {
  return async function burnPrecheckHandler(request: FastifyRequest, reply: FastifyReply) {
    let charge: GatedCharge | null = null;
    try {
      charge = await extract(request);
    } catch (err) {
      request.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'burn gate: charge extraction failed, proceeding ungated',
      );
      return;
    }
    if (!charge) return;

    let result: BurnPrecheckResult;
    try {
      result = await runBurnPrecheck(
        {
          redis: request.server.redis,
          config: burnPrecheckConfig(),
          logger: request.log,
        },
        {
          organization_id: request.user!.org_id,
          acting_user_id: request.user!.id,
          ...charge,
        },
      );
    } catch (err) {
      // Defensive. runBurnPrecheck is contractually non-throwing; if that contract is ever
      // broken, money still moves.
      request.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'burn gate threw, which it must not; proceeding ungated',
      );
      return;
    }

    request.burnGate = result;

    if (result.allowed) return;

    // The single blocking path. 409, with the four actions spec 5.7 requires: a block that
    // offers no way forward is a wall, which is how this feature gets switched off.
    //
    // `allowed === false` implies a response by construction (see runBurnPrecheck), but a
    // bare non-null assertion here would turn any future violation of that invariant into a
    // TypeError on a money route. On the one path in this file that can stop a write, be
    // explicit and fail OPEN if the invariant ever breaks.
    const verdict = result.response;
    if (!verdict) {
      request.log.warn(
        { org_id: request.user!.org_id },
        'burn gate reported a block with no verdict body, which it must not; proceeding ungated',
      );
      return;
    }
    return reply.status(409).send({
      error: {
        code: 'BURN_ENVELOPE_EXCEEDED',
        message:
          'This charge exceeds the confirmed envelope on its engagement. Map it to a deliverable, record it as absorbed, raise a change order, or override with a reason.',
        details: [
          {
            field: 'amount',
            issue: verdict.verdict_reason,
            precheck_id: verdict.precheck_id,
            engagement_id: verdict.engagement_id,
            deliverable_id: verdict.deliverable_id,
            consumption_band: verdict.consumption_band,
            overage_at_least: verdict.overage_amount_quantized,
            actions: [
              'map_to_deliverable',
              'record_absorbed_cost',
              'raise_change_order',
              'override',
            ],
          },
        ],
        request_id: request.id,
      },
    });
  };
}
