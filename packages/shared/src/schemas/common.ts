import { z } from 'zod';
import { DEFAULT_PAGINATION_LIMIT, MAX_PAGINATION_LIMIT } from '../constants/index.js';

export const uuidSchema = z.string().uuid();

export const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const sortSchema = z.string();

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGINATION_LIMIT)
    .default(DEFAULT_PAGINATION_LIMIT)
    .optional(),
});

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.record(z.unknown())).optional(),
    request_id: z.string(),
    // 500-class envelopes carry a fresh internal_error_id so an end user
    // pasting the failure id gives the operator a single grep target in
    // the structured logs without leaking the cause in the HTTP response.
    // See Platform_Plan.md (2026-04-13-revised) gap 2.3.2.
    internal_error_id: z.string().uuid().optional(),
  }),
});
