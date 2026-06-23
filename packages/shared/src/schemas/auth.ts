import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12),
  display_name: z.string().max(100),
  org_name: z.string().max(255),
});

export const bootstrapSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12),
  display_name: z.string().max(100),
  org_name: z.string().max(255),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  totp_code: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

export const magicLinkSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string(),
  new_password: z.string().min(12),
});

export const updateProfileSchema = z.object({
  display_name: z.string().max(100).optional(),
  // Accept an absolute http(s) URL, a bundled default-avatar path (/avatars/…),
  // or an uploaded-file proxy path (/files/…); null/'' clears the avatar.
  // (The old `.url()` rule rejected the relative paths the app actually uses.)
  avatar_url: z
    .string()
    .max(2048)
    .refine(
      (v) =>
        v === '' ||
        /^https?:\/\//.test(v) ||
        v.startsWith('/avatars/') ||
        v.startsWith('/files/'),
      { message: 'avatar_url must be an http(s) URL or an /avatars/ or /files/ path' },
    )
    .nullable()
    .optional(),
  timezone: z.string().optional(),
  notification_prefs: z.record(z.unknown()).optional(),
});
