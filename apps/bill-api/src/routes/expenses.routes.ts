import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as expenseService from '../services/expense.service.js';
import * as receiptService from '../services/receipt.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { loadActor, loadOrg } from '../lib/bolt-event-enrich.js';
import {
  burnPrecheck,
  expenseApproveCharge,
  expenseCreateCharge,
  expenseUpdateCharge,
} from '../lib/burn-precheck.hook.js';

const createExpenseSchema = z.object({
  project_id: z.string().uuid().optional(),
  description: z.string().min(1).max(1000),
  amount: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  category: z.string().max(60).optional(),
  vendor: z.string().max(255).optional(),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  receipt_url: z.string().url().optional(),
  receipt_filename: z.string().max(255).optional(),
  billable: z.boolean().optional(),
});

const updateExpenseSchema = createExpenseSchema.partial();

const listQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
});

export default async function expenseRoutes(fastify: FastifyInstance) {
  // GET /expenses
  fastify.get(
    '/expenses',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const result = await expenseService.listExpenses({
        organization_id: request.user!.org_id,
        ...query,
      });
      return reply.send(result);
    },
  );

  // POST /expenses
  // The gate sits AFTER requireCan, deliberately: a caller who may not create an expense
  // gets a 403 from the permission layer, never a financial verdict (spec 12.1, "the gate
  // is not an oracle").
  fastify.post(
    '/expenses',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bill.expense.create'),
        requireScope('read_write'),
        burnPrecheck(expenseCreateCharge),
      ],
    },
    async (request, reply) => {
      const body = createExpenseSchema.parse(request.body);
      const gate = request.burnGate;
      const expense = await expenseService.createExpense(
        body,
        request.user!.org_id,
        request.user!.id,
        {
          burn_gate: gate?.gate_marker ?? null,
          burn_precheck_id: gate?.response?.precheck_id ?? null,
        },
      );

      const [actor, org] = await Promise.all([
        loadActor(request.user!.id),
        loadOrg(request.user!.org_id),
      ]);
      publishBoltEvent(
        'expense.created',
        'bill',
        {
          expense: {
            id: expense.id,
            description: expense.description,
            amount: expense.amount,
            currency: expense.currency,
            category: expense.category,
            vendor: expense.vendor,
            project_id: expense.project_id,
            expense_date: expense.expense_date,
            billable: expense.billable,
            status: expense.status,
            created_at: expense.created_at,
          },
          // The gate's own residue, so a Bolt rule (and Burn's ingest) can tell a gated
          // charge from one that posted while the gate was down or absent.
          burn_gate: expense.burn_gate,
          burn_precheck_id: expense.burn_precheck_id,
          actor: { id: actor.id, name: actor.name, email: actor.email },
          org: { id: org.id, name: org.name, slug: org.slug },
        },
        request.user!.org_id,
        request.user!.id,
      );

      return reply.status(201).send({ data: expense });
    },
  );

  // PATCH /expenses/:id
  // Gated only when `amount` or `project_id` actually changes -- see expenseUpdateCharge.
  fastify.patch<{ Params: { id: string } }>(
    '/expenses/:id',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bill.expense.update'),
        requireScope('read_write'),
        burnPrecheck(expenseUpdateCharge),
      ],
    },
    async (request, reply) => {
      const body = updateExpenseSchema.parse(request.body);
      const expense = await expenseService.updateExpense(request.params.id, request.user!.org_id, body);
      return reply.send({ data: expense });
    },
  );

  // DELETE /expenses/:id
  fastify.delete<{ Params: { id: string } }>(
    '/expenses/:id',
    { preHandler: [requireAuth, fastify.requireCan('bill.expense.delete'), requireScope('read_write')] },
    async (request, reply) => {
      await expenseService.deleteExpense(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // POST /expenses/:id/approve
  // Spec 5.2 calls approval "the real money commitment", so it is gated even though
  // creation already was: an expense can be created small, edited, and only bites the firm
  // at approval.
  fastify.post<{ Params: { id: string } }>(
    '/expenses/:id/approve',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bill.expense.approve'),
        requireScope('read_write'),
        burnPrecheck(expenseApproveCharge),
      ],
    },
    async (request, reply) => {
      const expense = await expenseService.approveExpense(
        request.params.id,
        request.user!.org_id,
        request.user!.id,
      );

      const [actor, org] = await Promise.all([
        loadActor(request.user!.id),
        loadOrg(request.user!.org_id),
      ]);
      publishBoltEvent(
        'expense.approved',
        'bill',
        {
          expense: {
            id: expense.id,
            description: expense.description,
            amount: expense.amount,
            currency: expense.currency,
            category: expense.category,
            vendor: expense.vendor,
            project_id: expense.project_id,
            expense_date: expense.expense_date,
            billable: expense.billable,
            status: expense.status,
            submitted_by: expense.submitted_by,
          },
          burn_gate: request.burnGate?.gate_marker ?? null,
          burn_precheck_id: request.burnGate?.response?.precheck_id ?? null,
          approved_by: { id: actor.id, name: actor.name, email: actor.email },
          actor: { id: actor.id, name: actor.name, email: actor.email },
          org: { id: org.id, name: org.name, slug: org.slug },
        },
        request.user!.org_id,
        request.user!.id,
      );

      return reply.send({ data: expense });
    },
  );

  // POST /expenses/:id/reject
  fastify.post<{ Params: { id: string } }>(
    '/expenses/:id/reject',
    { preHandler: [requireAuth, fastify.requireCan('bill.expense.reject'), requireScope('read_write')] },
    async (request, reply) => {
      const expense = await expenseService.rejectExpense(
        request.params.id,
        request.user!.org_id,
        request.user!.id,
      );
      return reply.send({ data: expense });
    },
  );

  // POST /expenses/:id/reimburse — mark an approved expense as reimbursed
  fastify.post<{ Params: { id: string } }>(
    '/expenses/:id/reimburse',
    { preHandler: [requireAuth, fastify.requireCan('bill.expense.reimburse'), requireScope('read_write')] },
    async (request, reply) => {
      const expense = await expenseService.reimburseExpense(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: expense });
    },
  );

  // POST /expenses/:id/receipt -- Upload receipt file to MinIO
  fastify.post<{ Params: { id: string } }>(
    '/expenses/:id/receipt',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('bill.expense_receipt.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const file = await request.file();
      if (!file) {
        return reply.status(400).send({
          error: {
            code: 'MISSING_FILE',
            message: 'No file uploaded. Send a multipart form with a file field.',
            details: [],
            request_id: request.id,
          },
        });
      }

      const result = await receiptService.uploadReceipt(
        request.params.id,
        request.user!.org_id,
        {
          filename: file.filename,
          mimetype: file.mimetype,
          file: file.file,
        },
      );

      return reply.send({ data: result });
    },
  );
}
