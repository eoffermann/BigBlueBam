import type { z } from 'zod';
import type {
  registerSchema,
  bootstrapSchema,
  loginSchema,
  magicLinkSchema,
  resetPasswordSchema,
  updateProfileSchema,
  updateOrgSchema,
  inviteMemberSchema,
  updateMemberRoleSchema,
  createProjectSchema,
  updateProjectSchema,
  addProjectMemberSchema,
  createPhaseSchema,
  updatePhaseSchema,
  reorderPhasesSchema,
  createSprintSchema,
  updateSprintSchema,
  completeSprintSchema,
  createTaskSchema,
  updateTaskSchema,
  moveTaskSchema,
  bulkUpdateSchema,
  createCommentSchema,
  updateCommentSchema,
  paginationSchema,
  errorResponseSchema,
} from '../schemas/index.js';
import type {
  PRIORITIES,
  SPRINT_STATUSES,
  TASK_STATE_CATEGORIES,
  ORG_ROLES,
  PROJECT_ROLES,
} from '../constants/index.js';

// --- Inferred schema types ---

export type RegisterInput = z.infer<typeof registerSchema>;
export type BootstrapInput = z.infer<typeof bootstrapSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type MagicLinkInput = z.infer<typeof magicLinkSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type AddProjectMemberInput = z.infer<typeof addProjectMemberSchema>;

export type CreatePhaseInput = z.infer<typeof createPhaseSchema>;
export type UpdatePhaseInput = z.infer<typeof updatePhaseSchema>;
export type ReorderPhasesInput = z.infer<typeof reorderPhasesSchema>;

export type CreateSprintInput = z.infer<typeof createSprintSchema>;
export type UpdateSprintInput = z.infer<typeof updateSprintSchema>;
export type CompleteSprintInput = z.infer<typeof completeSprintSchema>;

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;
export type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>;

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

export type PaginationInput = z.infer<typeof paginationSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

// --- Constant-derived type aliases ---

export type Priority = (typeof PRIORITIES)[number];
export type SprintStatus = (typeof SPRINT_STATUSES)[number];
export type TaskStateCategory = (typeof TASK_STATE_CATEGORIES)[number];
export type OrgRole = (typeof ORG_ROLES)[number];
export type ProjectRole = (typeof PROJECT_ROLES)[number];

// --- Entity types ---

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  timezone: string | null;
  notification_prefs: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  org_id?: string;
  active_org_id?: string;
  is_superuser?: boolean;
  is_superuser_viewing?: boolean;
  role?: string;
  force_password_change?: boolean;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  task_id_prefix: string;
  default_sprint_duration_days: number;
  created_at: string;
  updated_at: string;
}

export interface Phase {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  color: string | null;
  position: number;
  wip_limit: number | null;
  is_start: boolean;
  is_terminal: boolean;
  auto_state_on_enter: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskState {
  id: string;
  project_id: string;
  name: string;
  color: string;
  icon: string | null;
  category: TaskStateCategory;
  position: number;
  is_default: boolean;
  is_closed: boolean;
  created_at: string;
}

export interface Sprint {
  id: string;
  project_id: string;
  name: string;
  goal: string | null;
  status: SprintStatus;
  start_date: string;
  end_date: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  human_id: string;
  title: string;
  description: string | null;
  description_plain: string | null;
  phase_id: string;
  state_id: string | null;
  sprint_id: string | null;
  assignee_id: string | null;
  reporter_id: string;
  priority: Priority;
  story_points: number | null;
  time_estimate_minutes: number | null;
  time_logged_minutes: number;
  position: number;
  start_date: string | null;
  due_date: string | null;
  completed_at: string | null;
  epic_id: string | null;
  parent_task_id: string | null;
  labels: string[];
  watchers: string[];
  is_blocked: boolean;
  blocking_task_ids: string[];
  blocked_by_task_ids: string[];
  custom_fields: Record<string, unknown>;
  attachment_count: number;
  comment_count: number;
  subtask_count: number;
  subtask_done_count: number;
  carry_forward_count: number;
  original_sprint_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  task_id: string;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Attachment {
  id: string;
  task_id: string;
  uploader_id: string;
  file_name: string;
  file_url: string;
  file_size: number;
  mime_type: string;
  created_at: string;
}

export interface Label {
  id: string;
  project_id: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface Epic {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityLogEntry {
  id: string;
  project_id: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  changes: Record<string, unknown>;
  created_at: string;
}

// --- API response types ---

export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    next_cursor: string | null;
    has_more: boolean;
    total_count?: number;
  };
}

export interface BoardResponse {
  project: Project;
  phases: (Phase & { tasks: Task[] })[];
  sprint: Sprint | null;
}

// ── Bearing types ──────────────────────────────────────────────────────
// Inferred type aliases use "Input" suffix to avoid collision with the
// Zod schemas of the same name re-exported from schemas/bearing.ts.
export type BearingPeriodTypeInput = z.infer<typeof import('../schemas/bearing.js').BearingPeriodType>;
export type BearingPeriodStatusInput = z.infer<typeof import('../schemas/bearing.js').BearingPeriodStatus>;
export type BearingGoalScopeInput = z.infer<typeof import('../schemas/bearing.js').BearingGoalScope>;
export type BearingGoalStatusInput = z.infer<typeof import('../schemas/bearing.js').BearingGoalStatus>;
export type BearingMetricTypeInput = z.infer<typeof import('../schemas/bearing.js').BearingMetricType>;
export type BearingProgressModeInput = z.infer<typeof import('../schemas/bearing.js').BearingProgressMode>;

// ── Notification queue types ────────────────────────────────────────────
export interface NotificationJobData {
  user_id: string;
  project_id: string;
  task_id?: string;
  type: string;
  title: string;
  body: string;
  category?: string;
  source_app?: string;
  deep_link?: string;
}
