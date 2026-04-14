import { describe, it, expect } from 'vitest';
import {
  // common
  uuidSchema,
  hexColorSchema,
  isoDateSchema,
  paginationSchema,
  errorResponseSchema,
  // auth
  registerSchema,
  loginSchema,
  magicLinkSchema,
  resetPasswordSchema,
  updateProfileSchema,
  // organization
  updateOrgSchema,
  inviteMemberSchema,
  updateMemberRoleSchema,
  // project
  createProjectSchema,
  updateProjectSchema,
  addProjectMemberSchema,
  // phase
  createPhaseSchema,
  updatePhaseSchema,
  reorderPhasesSchema,
  // sprint
  createSprintSchema,
  updateSprintSchema,
  completeSprintSchema,
  // task
  createTaskSchema,
  updateTaskSchema,
  moveTaskSchema,
  bulkUpdateSchema,
  // comment
  createCommentSchema,
  updateCommentSchema,
} from '../src/index.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID_2 = '660e8400-e29b-41d4-a716-446655440001';

// --- Common schemas ---

describe('uuidSchema', () => {
  it('accepts a valid UUID', () => {
    expect(uuidSchema.parse(VALID_UUID)).toBe(VALID_UUID);
  });

  it('rejects an invalid UUID', () => {
    expect(() => uuidSchema.parse('not-a-uuid')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => uuidSchema.parse('')).toThrow();
  });
});

describe('hexColorSchema', () => {
  it('accepts valid hex colors', () => {
    expect(hexColorSchema.parse('#FF00AA')).toBe('#FF00AA');
    expect(hexColorSchema.parse('#000000')).toBe('#000000');
    expect(hexColorSchema.parse('#abcdef')).toBe('#abcdef');
  });

  it('rejects invalid hex colors', () => {
    expect(() => hexColorSchema.parse('#FFF')).toThrow();
    expect(() => hexColorSchema.parse('FF00AA')).toThrow();
    expect(() => hexColorSchema.parse('#GGGGGG')).toThrow();
    expect(() => hexColorSchema.parse('')).toThrow();
  });
});

describe('isoDateSchema', () => {
  it('accepts valid ISO dates', () => {
    expect(isoDateSchema.parse('2025-01-15')).toBe('2025-01-15');
  });

  it('rejects invalid date formats', () => {
    expect(() => isoDateSchema.parse('01-15-2025')).toThrow();
    expect(() => isoDateSchema.parse('2025/01/15')).toThrow();
    expect(() => isoDateSchema.parse('')).toThrow();
  });
});

describe('paginationSchema', () => {
  it('accepts valid pagination', () => {
    const result = paginationSchema.parse({ cursor: 'abc', limit: 25 });
    expect(result.cursor).toBe('abc');
    expect(result.limit).toBe(25);
  });

  it('accepts empty object', () => {
    const result = paginationSchema.parse({});
    expect(result.cursor).toBeUndefined();
  });

  it('rejects limit above max', () => {
    expect(() => paginationSchema.parse({ limit: 300 })).toThrow();
  });

  it('rejects limit of 0', () => {
    expect(() => paginationSchema.parse({ limit: 0 })).toThrow();
  });
});

describe('errorResponseSchema', () => {
  it('accepts valid error response', () => {
    const input = {
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        request_id: 'req_123',
      },
    };
    expect(errorResponseSchema.parse(input)).toEqual(input);
  });

  it('accepts error response with details', () => {
    const input = {
      error: {
        code: 'VALIDATION',
        message: 'Validation failed',
        details: [{ field: 'email', issue: 'invalid' }],
        request_id: 'req_456',
      },
    };
    expect(errorResponseSchema.parse(input)).toEqual(input);
  });

  it('accepts error response with internal_error_id', () => {
    const input = {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        request_id: 'req_789',
        internal_error_id: '11111111-2222-4333-8444-555555555555',
      },
    };
    expect(errorResponseSchema.parse(input)).toEqual(input);
  });

  it('rejects internal_error_id that is not a UUID', () => {
    const input = {
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
        request_id: 'req_789',
        internal_error_id: 'not-a-uuid',
      },
    };
    expect(() => errorResponseSchema.parse(input)).toThrow();
  });
});

// --- Auth schemas ---

describe('registerSchema', () => {
  const valid = {
    email: 'user@example.com',
    password: 'securepass123!',
    display_name: 'Test User',
    org_name: 'Test Org',
  };

  it('accepts valid registration', () => {
    expect(registerSchema.parse(valid)).toEqual(valid);
  });

  it('rejects invalid email', () => {
    expect(() => registerSchema.parse({ ...valid, email: 'not-email' })).toThrow();
  });

  it('rejects short password', () => {
    expect(() => registerSchema.parse({ ...valid, password: 'short' })).toThrow();
  });

  it('rejects password with exactly 11 chars', () => {
    expect(() => registerSchema.parse({ ...valid, password: '12345678901' })).toThrow();
  });

  it('accepts password with exactly 12 chars', () => {
    expect(registerSchema.parse({ ...valid, password: '123456789012' })).toBeTruthy();
  });

  it('rejects email over 320 chars', () => {
    const longEmail = 'a'.repeat(310) + '@example.com';
    expect(() => registerSchema.parse({ ...valid, email: longEmail })).toThrow();
  });

  it('rejects display_name over 100 chars', () => {
    expect(() =>
      registerSchema.parse({ ...valid, display_name: 'a'.repeat(101) }),
    ).toThrow();
  });
});

describe('loginSchema', () => {
  it('accepts login without totp', () => {
    const result = loginSchema.parse({ email: 'a@b.com', password: 'pw' });
    expect(result.totp_code).toBeUndefined();
  });

  it('accepts login with valid totp', () => {
    const result = loginSchema.parse({
      email: 'a@b.com',
      password: 'pw',
      totp_code: '123456',
    });
    expect(result.totp_code).toBe('123456');
  });

  it('rejects invalid totp code', () => {
    expect(() =>
      loginSchema.parse({ email: 'a@b.com', password: 'pw', totp_code: '12345' }),
    ).toThrow();
    expect(() =>
      loginSchema.parse({ email: 'a@b.com', password: 'pw', totp_code: 'abcdef' }),
    ).toThrow();
  });
});

describe('magicLinkSchema', () => {
  it('accepts valid email', () => {
    expect(magicLinkSchema.parse({ email: 'test@test.com' })).toEqual({
      email: 'test@test.com',
    });
  });

  it('rejects missing email', () => {
    expect(() => magicLinkSchema.parse({})).toThrow();
  });
});

describe('resetPasswordSchema', () => {
  it('accepts valid input', () => {
    const input = { token: 'abc123', new_password: 'newpassword12' };
    expect(resetPasswordSchema.parse(input)).toEqual(input);
  });

  it('rejects short new_password', () => {
    expect(() =>
      resetPasswordSchema.parse({ token: 'abc', new_password: 'short' }),
    ).toThrow();
  });
});

describe('updateProfileSchema', () => {
  it('accepts partial updates', () => {
    expect(updateProfileSchema.parse({ display_name: 'New Name' })).toEqual({
      display_name: 'New Name',
    });
  });

  it('accepts empty object', () => {
    expect(updateProfileSchema.parse({})).toEqual({});
  });

  it('rejects invalid avatar_url', () => {
    expect(() => updateProfileSchema.parse({ avatar_url: 'not-a-url' })).toThrow();
  });
});

// --- Organization schemas ---

describe('updateOrgSchema', () => {
  it('accepts valid update', () => {
    const result = updateOrgSchema.parse({ name: 'New Org' });
    expect(result.name).toBe('New Org');
  });

  it('accepts empty object', () => {
    expect(updateOrgSchema.parse({})).toEqual({});
  });
});

describe('inviteMemberSchema', () => {
  it('accepts valid invite', () => {
    const result = inviteMemberSchema.parse({
      email: 'user@test.com',
      role: 'admin',
    });
    expect(result.role).toBe('admin');
  });

  it('accepts invite with project_ids', () => {
    const result = inviteMemberSchema.parse({
      email: 'user@test.com',
      role: 'member',
      project_ids: [VALID_UUID],
    });
    expect(result.project_ids).toEqual([VALID_UUID]);
  });

  it('rejects invalid role', () => {
    expect(() =>
      inviteMemberSchema.parse({ email: 'user@test.com', role: 'superadmin' }),
    ).toThrow();
  });

  it('rejects invalid UUID in project_ids', () => {
    expect(() =>
      inviteMemberSchema.parse({
        email: 'user@test.com',
        role: 'member',
        project_ids: ['bad-uuid'],
      }),
    ).toThrow();
  });
});

describe('updateMemberRoleSchema', () => {
  it('accepts valid role', () => {
    expect(updateMemberRoleSchema.parse({ role: 'owner' })).toEqual({ role: 'owner' });
  });

  it('rejects invalid role', () => {
    expect(() => updateMemberRoleSchema.parse({ role: 'invalid' })).toThrow();
  });
});

// --- Project schemas ---

describe('createProjectSchema', () => {
  const valid = {
    name: 'My Project',
    task_id_prefix: 'PRJ',
  };

  it('accepts valid project', () => {
    expect(createProjectSchema.parse(valid)).toMatchObject(valid);
  });

  it('accepts full project', () => {
    const full = {
      ...valid,
      slug: 'my-project',
      description: 'A description',
      icon: '🚀',
      color: '#FF0000',
      template: 'kanban_standard' as const,
    };
    expect(createProjectSchema.parse(full)).toMatchObject(full);
  });

  it('rejects invalid slug', () => {
    expect(() =>
      createProjectSchema.parse({ ...valid, slug: 'Invalid Slug!' }),
    ).toThrow();
  });

  it('rejects invalid task_id_prefix', () => {
    expect(() =>
      createProjectSchema.parse({ ...valid, task_id_prefix: 'a' }),
    ).toThrow();
    expect(() =>
      createProjectSchema.parse({ ...valid, task_id_prefix: 'TOOLONGX' }),
    ).toThrow();
    expect(() =>
      createProjectSchema.parse({ ...valid, task_id_prefix: '123' }),
    ).toThrow();
  });

  it('rejects name over 255 chars', () => {
    expect(() =>
      createProjectSchema.parse({ ...valid, name: 'a'.repeat(256) }),
    ).toThrow();
  });
});

describe('updateProjectSchema', () => {
  it('accepts partial update', () => {
    expect(updateProjectSchema.parse({ name: 'Updated' })).toMatchObject({
      name: 'Updated',
    });
  });

  it('accepts empty object', () => {
    expect(updateProjectSchema.parse({})).toEqual({});
  });
});

describe('addProjectMemberSchema', () => {
  it('accepts valid input', () => {
    const result = addProjectMemberSchema.parse({
      user_id: VALID_UUID,
      role: 'viewer',
    });
    expect(result.role).toBe('viewer');
  });

  it('rejects invalid role', () => {
    expect(() =>
      addProjectMemberSchema.parse({ user_id: VALID_UUID, role: 'owner' }),
    ).toThrow();
  });
});

// --- Phase schemas ---

describe('createPhaseSchema', () => {
  const valid = { name: 'To Do', position: 0 };

  it('accepts valid phase', () => {
    expect(createPhaseSchema.parse(valid)).toMatchObject(valid);
  });

  it('accepts phase with all fields', () => {
    const full = {
      ...valid,
      description: 'Items to do',
      color: '#00FF00',
      wip_limit: 5,
      is_start: true,
      is_terminal: false,
      auto_state_on_enter: VALID_UUID,
    };
    expect(createPhaseSchema.parse(full)).toMatchObject(full);
  });

  it('accepts null wip_limit', () => {
    const result = createPhaseSchema.parse({ ...valid, wip_limit: null });
    expect(result.wip_limit).toBeNull();
  });

  it('rejects negative position', () => {
    expect(() => createPhaseSchema.parse({ ...valid, position: -1 })).toThrow();
  });

  it('rejects name over 100 chars', () => {
    expect(() =>
      createPhaseSchema.parse({ ...valid, name: 'a'.repeat(101) }),
    ).toThrow();
  });
});

describe('updatePhaseSchema', () => {
  it('accepts partial update', () => {
    expect(updatePhaseSchema.parse({ name: 'Done' })).toMatchObject({ name: 'Done' });
  });
});

describe('reorderPhasesSchema', () => {
  it('accepts valid uuid array', () => {
    const result = reorderPhasesSchema.parse({ phase_ids: [VALID_UUID, VALID_UUID_2] });
    expect(result.phase_ids).toHaveLength(2);
  });

  it('rejects invalid uuids', () => {
    expect(() => reorderPhasesSchema.parse({ phase_ids: ['bad'] })).toThrow();
  });
});

// --- Sprint schemas ---

describe('createSprintSchema', () => {
  const valid = {
    name: 'Sprint 1',
    start_date: '2025-01-01',
    end_date: '2025-01-15',
  };

  it('accepts valid sprint', () => {
    expect(createSprintSchema.parse(valid)).toMatchObject(valid);
  });

  it('accepts sprint with goal', () => {
    const result = createSprintSchema.parse({ ...valid, goal: 'Ship feature X' });
    expect(result.goal).toBe('Ship feature X');
  });

  it('rejects invalid date format', () => {
    expect(() =>
      createSprintSchema.parse({ ...valid, start_date: '01/01/2025' }),
    ).toThrow();
  });

  it('rejects name over 100 chars', () => {
    expect(() =>
      createSprintSchema.parse({ ...valid, name: 'a'.repeat(101) }),
    ).toThrow();
  });
});

describe('updateSprintSchema', () => {
  it('accepts partial update', () => {
    expect(updateSprintSchema.parse({ goal: 'New goal' })).toMatchObject({
      goal: 'New goal',
    });
  });
});

describe('completeSprintSchema', () => {
  it('accepts valid completion', () => {
    const input = {
      carry_forward: {
        target_sprint_id: VALID_UUID,
        tasks: [
          { task_id: VALID_UUID_2, action: 'carry_forward' as const },
          { task_id: VALID_UUID, action: 'backlog' as const },
        ],
      },
      retrospective_notes: 'Went well.',
    };
    expect(completeSprintSchema.parse(input)).toEqual(input);
  });

  it('rejects invalid action', () => {
    expect(() =>
      completeSprintSchema.parse({
        carry_forward: {
          target_sprint_id: VALID_UUID,
          tasks: [{ task_id: VALID_UUID, action: 'invalid' }],
        },
      }),
    ).toThrow();
  });
});

// --- Task schemas ---

describe('createTaskSchema', () => {
  const valid = {
    title: 'Implement login',
    phase_id: VALID_UUID,
  };

  it('accepts minimal task', () => {
    expect(createTaskSchema.parse(valid)).toMatchObject(valid);
  });

  it('accepts full task', () => {
    const full = {
      ...valid,
      description: 'Build the login page',
      state_id: VALID_UUID,
      sprint_id: VALID_UUID,
      assignee_id: VALID_UUID,
      priority: 'high' as const,
      story_points: 5,
      time_estimate_minutes: 120,
      start_date: '2025-01-01',
      due_date: '2025-01-15',
      label_ids: [VALID_UUID],
      epic_id: VALID_UUID,
      parent_task_id: VALID_UUID,
      custom_fields: { key: 'value' },
    };
    expect(createTaskSchema.parse(full)).toMatchObject(full);
  });

  it('accepts nullable fields as null', () => {
    const result = createTaskSchema.parse({
      ...valid,
      sprint_id: null,
      assignee_id: null,
      story_points: null,
      due_date: null,
    });
    expect(result.sprint_id).toBeNull();
    expect(result.assignee_id).toBeNull();
  });

  it('rejects title over 500 chars', () => {
    expect(() =>
      createTaskSchema.parse({ ...valid, title: 'a'.repeat(501) }),
    ).toThrow();
  });

  it('rejects invalid priority', () => {
    expect(() =>
      createTaskSchema.parse({ ...valid, priority: 'urgent' }),
    ).toThrow();
  });

  it('rejects invalid UUID for phase_id', () => {
    expect(() =>
      createTaskSchema.parse({ ...valid, phase_id: 'not-uuid' }),
    ).toThrow();
  });
});

describe('updateTaskSchema', () => {
  it('accepts partial update', () => {
    expect(updateTaskSchema.parse({ title: 'New title' })).toMatchObject({
      title: 'New title',
    });
  });

  it('accepts empty object', () => {
    expect(updateTaskSchema.parse({})).toEqual({});
  });
});

describe('moveTaskSchema', () => {
  it('accepts valid move', () => {
    const result = moveTaskSchema.parse({ phase_id: VALID_UUID, position: 0 });
    expect(result.position).toBe(0);
  });

  it('accepts move with sprint_id', () => {
    const result = moveTaskSchema.parse({
      phase_id: VALID_UUID,
      position: 3,
      sprint_id: VALID_UUID,
    });
    expect(result.sprint_id).toBe(VALID_UUID);
  });

  it('accepts null sprint_id', () => {
    const result = moveTaskSchema.parse({
      phase_id: VALID_UUID,
      position: 0,
      sprint_id: null,
    });
    expect(result.sprint_id).toBeNull();
  });
});

describe('bulkUpdateSchema', () => {
  it('accepts valid bulk update', () => {
    const result = bulkUpdateSchema.parse({
      task_ids: [VALID_UUID, VALID_UUID_2],
      operation: 'update',
      fields: { priority: 'high' },
    });
    expect(result.task_ids).toHaveLength(2);
  });

  it('accepts bulk delete without fields', () => {
    const result = bulkUpdateSchema.parse({
      task_ids: [VALID_UUID],
      operation: 'delete',
    });
    expect(result.operation).toBe('delete');
  });

  it('rejects invalid operation', () => {
    expect(() =>
      bulkUpdateSchema.parse({ task_ids: [VALID_UUID], operation: 'archive' }),
    ).toThrow();
  });

  it('rejects empty task_ids with invalid uuids', () => {
    expect(() =>
      bulkUpdateSchema.parse({ task_ids: ['bad'], operation: 'update' }),
    ).toThrow();
  });
});

// --- Comment schemas ---

describe('createCommentSchema', () => {
  it('accepts valid comment', () => {
    expect(createCommentSchema.parse({ body: 'A comment' })).toEqual({
      body: 'A comment',
    });
  });

  it('rejects empty body', () => {
    expect(() => createCommentSchema.parse({ body: '' })).toThrow();
  });

  it('rejects missing body', () => {
    expect(() => createCommentSchema.parse({})).toThrow();
  });
});

describe('updateCommentSchema', () => {
  it('accepts valid update', () => {
    expect(updateCommentSchema.parse({ body: 'Updated' })).toEqual({
      body: 'Updated',
    });
  });

  it('rejects empty body', () => {
    expect(() => updateCommentSchema.parse({ body: '' })).toThrow();
  });
});
