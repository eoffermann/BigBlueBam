import { z } from 'zod';
import { PROJECT_ROLES, PROJECT_TEMPLATES, DEFAULT_SPRINT_DURATION_DAYS } from '../constants/index.js';
import { uuidSchema, hexColorSchema } from './common.js';

export const createProjectSchema = z.object({
  name: z.string().max(255),
  slug: z
    .string()
    .max(100)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().optional(),
  icon: z.string().max(10).optional(),
  color: hexColorSchema.optional(),
  task_id_prefix: z.string().regex(/^[A-Z]{2,6}$/),
  default_sprint_duration_days: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_SPRINT_DURATION_DAYS)
    .optional(),
  template: z.enum(PROJECT_TEMPLATES).optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

/**
 * Body of the api's server-to-server POST /internal/projects/ensure (#364). Creates a project
 * through the same createProject the signed-in POST /projects uses (creator membership, template
 * phases and task states) on behalf of created_by in org_id. Idempotent on (org_id, ensure_key),
 * the caller's own operation id (#373): a replay answers the project that operation created.
 * slug is the preferred slug; when another project already holds it the new project takes the
 * first free suffixed slug (slug-2, slug-3, ...), so an unrelated project is never answered.
 * Caller: the worker's Slack import, project mode create_new (ensure_key slack-import:<import id>).
 */
export const internalEnsureProjectSchema = createProjectSchema.extend({
  org_id: uuidSchema,
  created_by: uuidSchema,
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
  ensure_key: z.string().min(1).max(200),
});

export type InternalEnsureProjectInput = z.infer<typeof internalEnsureProjectSchema>;

export const addProjectMemberSchema = z.object({
  user_id: uuidSchema,
  role: z.enum(PROJECT_ROLES),
});
