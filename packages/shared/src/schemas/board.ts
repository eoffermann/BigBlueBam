import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────
export const BoardBackground = z.enum(['dots', 'grid', 'lines', 'plain']);
export const BoardVisibility = z.enum(['private', 'project', 'organization']);
export const BoardCollaboratorPermission = z.enum(['view', 'edit']);
export const BoardElementExportFormat = z.enum(['json', 'svg', 'png']);

// ── Board schemas ──────────────────────────────────────────────────────
export const createBoardSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(10).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  template_id: z.string().uuid().nullable().optional(),
  background: BoardBackground.optional().default('dots'),
  visibility: BoardVisibility.optional().default('project'),
  default_viewport: z.record(z.unknown()).nullable().optional(),
});

export const updateBoardSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(10).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  background: BoardBackground.optional(),
  visibility: BoardVisibility.optional(),
  default_viewport: z.record(z.unknown()).nullable().optional(),
  thumbnail_url: z.string().max(2048).nullable().optional(),
});

export const listBoardsQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  visibility: BoardVisibility.optional(),
  created_by: z.string().uuid().optional(),
  archived: z.enum(['true', 'false']).optional(),
  search: z.string().max(500).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const searchBoardsQuerySchema = z.object({
  q: z.string().min(1).max(500),
});

// ── Element schemas ────────────────────────────────────────────────────
export const createBoardStickySchema = z.object({
  text: z.string().min(1).max(5000),
  x: z.number().default(100),
  y: z.number().default(100),
  width: z.number().min(10).max(2000).default(200),
  height: z.number().min(10).max(2000).default(200),
  color: z.string().max(30).default('#FFEB3B'),
});

export const createBoardTextSchema = z.object({
  text: z.string().min(1).max(10000),
  x: z.number().default(100),
  y: z.number().default(100),
  font_size: z.number().min(8).max(200).default(20),
  color: z.string().max(30).default('#000000'),
});

export const exportBoardElementsQuerySchema = z.object({
  format: BoardElementExportFormat.default('json'),
});

// ── Scene schemas ──────────────────────────────────────────────────────
export const saveBoardSceneSchema = z.object({
  elements: z.array(z.unknown()),
  appState: z.record(z.unknown()).optional(),
  files: z.record(z.unknown()).optional(),
});

// ── Chat schemas ───────────────────────────────────────────────────────
export const sendBoardChatMessageSchema = z.object({
  body: z.string().min(1).max(5000),
});

// ── Collaborator schemas ───────────────────────────────────────────────
export const addBoardCollaboratorSchema = z.object({
  user_id: z.string().uuid(),
  permission: BoardCollaboratorPermission.optional().default('edit'),
});

export const updateBoardCollaboratorSchema = z.object({
  permission: BoardCollaboratorPermission,
});

// ── Link / promote schemas ─────────────────────────────────────────────
export const promoteBoardElementsSchema = z.object({
  element_ids: z.array(z.string().uuid()).min(1).max(100),
  project_id: z.string().uuid(),
  phase_id: z.string().uuid().optional(),
});

// ── Template schemas ───────────────────────────────────────────────────
export const createBoardTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  icon: z.string().max(10).nullable().optional(),
  board_id: z.string().uuid().optional(),
});

export const updateBoardTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  icon: z.string().max(10).nullable().optional(),
  sort_order: z.number().int().min(0).max(10000).optional(),
});

export const instantiateBoardTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  project_id: z.string().uuid().optional(),
});

export const listBoardTemplatesQuerySchema = z.object({
  category: z.string().max(100).optional(),
});

// ── Version schemas ────────────────────────────────────────────────────
export const createBoardVersionSchema = z.object({
  name: z.string().min(1).max(255).optional(),
});
