import { describe, it, expect } from 'vitest';
import {
  registerSchema,
  loginSchema,
  createProjectSchema,
  createTaskSchema,
  moveTaskSchema,
  completeSprintSchema,
} from '@bigbluebam/shared';

const validUuid = '550e8400-e29b-41d4-a716-446655440000';

describe('Validation Schemas', () => {
  describe('registerSchema', () => {
    const validInput = {
      email: 'user@example.com',
      password: 'securePassword1!',
      display_name: 'Test User',
      org_name: 'My Organization',
    };

    it('valid input passes', () => {
      const result = registerSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('rejects short password (< 12 chars)', () => {
      const result = registerSchema.safeParse({
        ...validInput,
        password: 'short',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const passwordError = result.error.errors.find((e) => e.path.includes('password'));
        expect(passwordError).toBeDefined();
      }
    });

    it('rejects invalid email', () => {
      const result = registerSchema.safeParse({
        ...validInput,
        email: 'not-an-email',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const emailError = result.error.errors.find((e) => e.path.includes('email'));
        expect(emailError).toBeDefined();
      }
    });

    it('rejects missing display_name', () => {
      const { display_name, ...missing } = validInput;
      const result = registerSchema.safeParse(missing);
      expect(result.success).toBe(false);
    });

    it('rejects missing org_name', () => {
      const { org_name, ...missing } = validInput;
      const result = registerSchema.safeParse(missing);
      expect(result.success).toBe(false);
    });
  });

  describe('loginSchema', () => {
    const validInput = {
      email: 'user@example.com',
      password: 'any-password',
    };

    it('valid input passes', () => {
      const result = loginSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('totp_code is optional', () => {
      const result = loginSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.totp_code).toBeUndefined();
      }
    });

    it('accepts valid totp_code (6 digits)', () => {
      const result = loginSchema.safeParse({
        ...validInput,
        totp_code: '123456',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid totp_code (non-digits)', () => {
      const result = loginSchema.safeParse({
        ...validInput,
        totp_code: 'abcdef',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid totp_code (wrong length)', () => {
      const result = loginSchema.safeParse({
        ...validInput,
        totp_code: '12345',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('createProjectSchema', () => {
    const validInput = {
      name: 'My Project',
      task_id_prefix: 'PRJ',
    };

    it('valid input passes', () => {
      const result = createProjectSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('task_id_prefix must be 2-6 uppercase letters', () => {
      // Valid: 2 chars
      expect(createProjectSchema.safeParse({ ...validInput, task_id_prefix: 'AB' }).success).toBe(true);
      // Valid: 6 chars
      expect(createProjectSchema.safeParse({ ...validInput, task_id_prefix: 'ABCDEF' }).success).toBe(true);

      // Invalid: 1 char
      expect(createProjectSchema.safeParse({ ...validInput, task_id_prefix: 'A' }).success).toBe(false);
      // Invalid: 7 chars
      expect(createProjectSchema.safeParse({ ...validInput, task_id_prefix: 'ABCDEFG' }).success).toBe(false);
      // Invalid: lowercase
      expect(createProjectSchema.safeParse({ ...validInput, task_id_prefix: 'abc' }).success).toBe(false);
      // Invalid: numbers
      expect(createProjectSchema.safeParse({ ...validInput, task_id_prefix: 'AB1' }).success).toBe(false);
    });

    it('accepts optional template', () => {
      const result = createProjectSchema.safeParse({
        ...validInput,
        template: 'kanban_standard',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid template', () => {
      const result = createProjectSchema.safeParse({
        ...validInput,
        template: 'invalid_template',
      });
      expect(result.success).toBe(false);
    });

    it('accepts optional slug with valid format', () => {
      const result = createProjectSchema.safeParse({
        ...validInput,
        slug: 'my-project-123',
      });
      expect(result.success).toBe(true);
    });

    it('rejects slug with uppercase or special chars', () => {
      const result = createProjectSchema.safeParse({
        ...validInput,
        slug: 'My Project!',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('createTaskSchema', () => {
    const validInput = {
      title: 'Fix the login bug',
      phase_id: validUuid,
    };

    it('valid input passes', () => {
      const result = createTaskSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('title is required', () => {
      const result = createTaskSchema.safeParse({ phase_id: validUuid });
      expect(result.success).toBe(false);
      if (!result.success) {
        const titleError = result.error.errors.find((e) => e.path.includes('title'));
        expect(titleError).toBeDefined();
      }
    });

    it('title max length is 500', () => {
      const result = createTaskSchema.safeParse({
        ...validInput,
        title: 'x'.repeat(501),
      });
      expect(result.success).toBe(false);

      const validLong = createTaskSchema.safeParse({
        ...validInput,
        title: 'x'.repeat(500),
      });
      expect(validLong.success).toBe(true);
    });

    it('phase_id is required and must be uuid', () => {
      const noPhase = createTaskSchema.safeParse({ title: 'Test' });
      expect(noPhase.success).toBe(false);

      const badPhase = createTaskSchema.safeParse({ title: 'Test', phase_id: 'not-a-uuid' });
      expect(badPhase.success).toBe(false);
    });

    it('accepts optional fields', () => {
      const result = createTaskSchema.safeParse({
        ...validInput,
        description: 'Some description',
        priority: 'high',
        assignee_id: validUuid,
        sprint_id: validUuid,
        story_points: 5,
        label_ids: [validUuid],
      });
      expect(result.success).toBe(true);
    });

    it('accepts org-defined priority slugs (priorities are per-org configurable)', () => {
      // Migration 0183: priority is no longer an enum — orgs define their
      // own rows and the wire carries the row's value slug. Existence is
      // validated at the service layer where the org is known.
      const result = createTaskSchema.safeParse({
        ...validInput,
        priority: 'super-urgent',
      });
      expect(result.success).toBe(true);
    });

    it('rejects priority values that are not valid slugs', () => {
      const result = createTaskSchema.safeParse({
        ...validInput,
        priority: 'Not A Slug!',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('moveTaskSchema', () => {
    it('requires phase_id and position', () => {
      const valid = moveTaskSchema.safeParse({
        phase_id: validUuid,
        position: 1024,
      });
      expect(valid.success).toBe(true);
    });

    it('rejects missing phase_id', () => {
      const result = moveTaskSchema.safeParse({ position: 1024 });
      expect(result.success).toBe(false);
    });

    it('rejects missing position', () => {
      const result = moveTaskSchema.safeParse({ phase_id: validUuid });
      expect(result.success).toBe(false);
    });

    it('accepts optional sprint_id', () => {
      const result = moveTaskSchema.safeParse({
        phase_id: validUuid,
        position: 512,
        sprint_id: validUuid,
      });
      expect(result.success).toBe(true);
    });

    it('accepts null sprint_id', () => {
      const result = moveTaskSchema.safeParse({
        phase_id: validUuid,
        position: 512,
        sprint_id: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('completeSprintSchema', () => {
    const validInput = {
      carry_forward: {
        target_sprint_id: validUuid,
        tasks: [
          { task_id: validUuid, action: 'carry_forward' as const },
          { task_id: '660e8400-e29b-41d4-a716-446655440001', action: 'backlog' as const },
        ],
      },
    };

    it('requires carry_forward with valid actions', () => {
      const result = completeSprintSchema.safeParse(validInput);
      expect(result.success).toBe(true);
    });

    it('rejects missing carry_forward', () => {
      const result = completeSprintSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects invalid action', () => {
      const result = completeSprintSchema.safeParse({
        carry_forward: {
          target_sprint_id: validUuid,
          tasks: [
            { task_id: validUuid, action: 'invalid_action' },
          ],
        },
      });
      expect(result.success).toBe(false);
    });

    it('requires target_sprint_id to be a valid uuid', () => {
      const result = completeSprintSchema.safeParse({
        carry_forward: {
          target_sprint_id: 'not-uuid',
          tasks: [],
        },
      });
      expect(result.success).toBe(false);
    });

    it('accepts optional retrospective_notes', () => {
      const result = completeSprintSchema.safeParse({
        ...validInput,
        retrospective_notes: 'Good sprint overall',
      });
      expect(result.success).toBe(true);
    });

    it('accepts all valid action types', () => {
      for (const action of ['carry_forward', 'backlog', 'cancel'] as const) {
        const result = completeSprintSchema.safeParse({
          carry_forward: {
            target_sprint_id: validUuid,
            tasks: [{ task_id: validUuid, action }],
          },
        });
        expect(result.success).toBe(true);
      }
    });
  });
});
