import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import * as expenseService from '../services/expense.service.js';
import * as receiptService from '../services/receipt.service.js';

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
  fastify.post(
    '/expenses',
    { preHandler: [requireAuth, fastify.requireCan('bill.expense.create'), requireScope('read_write')] },
    async (request, reply) => {
      const body = createExpenseSchema.parse(request.body);
      const expense = await expenseService.createExpense(body, request.user!.org_id, request.user!.id);
      return reply.status(201).send({ data: expense });
    },
  );

  // PATCH /expenses/:id
  fastify.patch<{ Params: { id: string } }>(
    '/expenses/:id',
    { preHandler: [requireAuth, fastify.requireCan('bill.expense.update'), requireScope('read_write')] },
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
  fastify.post<{ Params: { id: string } }>(
    '/expenses/:id/approve',
    { preHandler: [requireAuth, fastify.requireCan('bill.expense.approve'), requireScope('read_write')] },
    async (request, reply) => {
      const expense = await expenseService.approveExpense(
        request.params.id,
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
