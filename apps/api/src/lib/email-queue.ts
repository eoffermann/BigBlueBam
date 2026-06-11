// Lightweight BullMQ producer for the shared `email` queue.
//
// The worker service (apps/worker) owns actual SMTP delivery via
// processEmailJob. The API only enqueues jobs here. Job shape must match
// apps/worker/src/jobs/email.job.ts → EmailJobData.
//
// Every send function returns `email_sent: boolean`. The boolean is the
// answer to "is the platform actually configured to deliver this?" — NOT
// "did SMTP_HOST env var get set", which is what the previous
// implementation checked and which was wrong any time the operator
// configured SMTP via the SuperUser UI (system_settings). The resolver
// now consults system_settings first, env vars second — same precedence
// the worker uses, so the API's reported flag and the worker's actual
// delivery behavior can never disagree.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  SMTP_SETTING_KEYS,
  isSmtpConfigured as resolveIsSmtpConfigured,
} from '@bigbluebam/smtp-resolver';
import { sql, inArray } from 'drizzle-orm';
import { env } from '../env.js';
import { spaBase } from './urls.js';
import { db } from '../db/index.js';
import { systemSettings } from '../db/schema/system-settings.js';

export interface EmailJobData {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

let _queue: Queue<EmailJobData> | null = null;

function getQueue(): Queue<EmailJobData> {
  if (!_queue) {
    const connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    _queue = new Queue<EmailJobData>('email', { connection });
  }
  return _queue;
}

/**
 * Loads the smtp_* rows from system_settings as a plain map. Used by
 * the shared resolver to do the precedence math against env vars. The
 * resolver caches the resolved config for 30s; this loader is only
 * called when that cache is cold or expired.
 */
async function loadSmtpSettings(): Promise<Record<string, unknown>> {
  try {
    const rows = await db
      .select({ key: systemSettings.key, value: systemSettings.value })
      .from(systemSettings)
      .where(inArray(systemSettings.key, [...SMTP_SETTING_KEYS]));
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } catch {
    // Don't crash if the table is missing on a fresh deploy or RLS
    // blocks the read — the resolver will fall through to env vars.
    return {};
  }
}

const RESOLVER_ENV = {
  SMTP_HOST: env.SMTP_HOST,
  SMTP_PORT: env.SMTP_PORT,
  SMTP_USER: env.SMTP_USER,
  SMTP_PASS: env.SMTP_PASS,
  EMAIL_FROM: env.SMTP_FROM,
};

/**
 * Async because the resolver reads system_settings. Cached for 30s
 * inside the resolver, so cheap on the hot path. Callers can await it
 * once per request without measurable overhead.
 */
export async function isSmtpConfigured(): Promise<boolean> {
  return resolveIsSmtpConfigured(loadSmtpSettings, RESOLVER_ENV);
}

// Silence the unused-import warning when `sql` happens to be tree-
// shaken; we keep it for the eventual addition of a manual-override
// route that needs raw SQL.
void sql;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface GuestInvitationEmailParams {
  to: string;
  token: string;
  orgName: string;
  inviterName: string;
}

/**
 * Enqueue a guest invitation email containing the acceptance link.
 * Returns true if the job was successfully enqueued AND SMTP is
 * configured (so the worker will actually deliver). Returns false if
 * either step is missing.
 */
export async function sendGuestInvitationEmail(
  params: GuestInvitationEmailParams,
): Promise<boolean> {
  const { to, token, orgName, inviterName } = params;
  const acceptUrl = `${spaBase()}/guests/accept/${token}`;

  const safeOrg = escapeHtml(orgName);
  const safeInviter = escapeHtml(inviterName);
  const safeUrl = escapeHtml(acceptUrl);

  const subject = `You've been invited to ${orgName} on BigBlueBam`;
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111;">
<h2>You've been invited to ${safeOrg}</h2>
<p>${safeInviter} has invited you to collaborate on BigBlueBam.</p>
<p>
  <a href="${safeUrl}"
     style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">
    Accept invitation
  </a>
</p>
<p>Or copy this link into your browser:<br/><code>${safeUrl}</code></p>
<p style="color:#666;font-size:12px;">If you weren't expecting this invitation, you can safely ignore this email.</p>
</body></html>`;

  const text = `You've been invited to ${orgName} on BigBlueBam by ${inviterName}.

Accept your invitation: ${acceptUrl}

If you weren't expecting this invitation, you can safely ignore this email.`;

  try {
    await getQueue().add(
      'guest-invitation',
      { to, subject, html, text },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
    return await isSmtpConfigured();
  } catch {
    return false;
  }
}

// ─── Email verification (used by SuperUser email change flow) ──────────────

export interface EmailVerificationParams {
  to: string;
  token: string;
  userName: string;
}

/**
 * Enqueue a verification email to a user's NEW address after a SuperUser
 * (or self-service flow) has initiated an email change. The recipient
 * clicks the link inside to confirm ownership of the new address.
 */
export async function sendEmailVerificationEmail(
  params: EmailVerificationParams,
): Promise<boolean> {
  const { to, token, userName } = params;
  const verifyUrl = `${spaBase()}/verify-email/${token}`;

  const safeName = escapeHtml(userName);
  const safeUrl = escapeHtml(verifyUrl);

  const subject = 'Verify your new email address for BigBlueBam';
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111;">
<h2>Verify your new email</h2>
<p>Hi ${safeName},</p>
<p>An email change has been initiated on your BigBlueBam account.
Please confirm ownership of this new email address by clicking the
button below. This link will expire in 7 days.</p>
<p>
  <a href="${safeUrl}"
     style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">
    Verify email
  </a>
</p>
<p>Or copy this link into your browser:<br/><code>${safeUrl}</code></p>
<p style="color:#666;font-size:12px;">If you did not expect this, you can safely ignore this email — nothing will change until you click the link.</p>
</body></html>`;

  const text = `Hi ${userName},

An email change has been initiated on your BigBlueBam account.
Verify this new address: ${verifyUrl}

This link expires in 7 days. If you did not expect this, ignore this email.`;

  try {
    await getQueue().add(
      'email-verification',
      { to, subject, html, text },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
    return await isSmtpConfigured();
  } catch {
    return false;
  }
}

export interface EmailChangeNoticeParams {
  to: string;
  userName: string;
  newEmail: string;
}

/**
 * Enqueue a courtesy notice to a user's OLD (current) email warning that
 * an email-change request was initiated. Non-blocking — the outgoing
 * change is controlled entirely by the verification link sent to the NEW
 * address.
 */
export async function sendEmailChangeNoticeEmail(
  params: EmailChangeNoticeParams,
): Promise<boolean> {
  const { to, userName, newEmail } = params;

  const safeName = escapeHtml(userName);
  const safeNew = escapeHtml(newEmail);

  const subject = 'Email change requested on your BigBlueBam account';
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111;">
<h2>Email change requested</h2>
<p>Hi ${safeName},</p>
<p>Someone has requested that your BigBlueBam account email be changed to
<strong>${safeNew}</strong>.</p>
<p>No change has been made yet — the new address must be verified first.
If you did not request this, please contact your organization administrator
immediately.</p>
</body></html>`;

  const text = `Hi ${userName},

Someone has requested that your BigBlueBam account email be changed to ${newEmail}.
No change has been made yet — the new address must be verified first.
If you did not request this, please contact your organization administrator immediately.`;

  try {
    await getQueue().add(
      'email-change-notice',
      { to, subject, html, text },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
    return await isSmtpConfigured();
  } catch {
    return false;
  }
}

// ─── Password reset (B3 Frndo Launch) ─────────────────────────────────────

export interface PasswordResetEmailParams {
  to: string;
  /** Raw token. Will be embedded in the reset URL — never log it. */
  token: string;
  userName: string;
  expiresInMinutes: number;
}

/**
 * Enqueue a password-reset link email. Triggered by:
 *   - admin "Send password reset link" button on the people-detail page
 *   - self-serve forgot-password (when wired up)
 *
 * The reset URL points at /b3/password-reset?token=<raw token>. The token
 * itself is the secret; the route consumes it via POST and burns it.
 */
export async function sendPasswordResetEmail(
  params: PasswordResetEmailParams,
): Promise<boolean> {
  const { to, token, userName, expiresInMinutes } = params;
  const resetUrl = `${spaBase()}/password-reset?token=${encodeURIComponent(token)}`;

  const safeName = escapeHtml(userName);
  const safeUrl = escapeHtml(resetUrl);

  const subject = 'Reset your BigBlueBam password';
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111;">
<h2>Reset your password</h2>
<p>Hi ${safeName},</p>
<p>We received a request to reset your BigBlueBam password. Click the
button below to choose a new one. This link expires in ${expiresInMinutes} minutes.</p>
<p>
  <a href="${safeUrl}"
     style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">
    Reset password
  </a>
</p>
<p>Or copy this link into your browser:<br/><code>${safeUrl}</code></p>
<p style="color:#666;font-size:12px;">If you didn't request this, you can safely ignore this email — your password won't change until someone clicks the link.</p>
</body></html>`;

  const text = `Hi ${userName},

We received a request to reset your BigBlueBam password.
Open this link to choose a new one (expires in ${expiresInMinutes} minutes):
${resetUrl}

If you didn't request this, ignore this email.`;

  try {
    await getQueue().add(
      'password-reset',
      { to, subject, html, text },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
    return await isSmtpConfigured();
  } catch {
    return false;
  }
}

// ─── Member invitation (B3 Frndo Launch) ──────────────────────────────────

export interface MemberInvitationEmailParams {
  to: string;
  orgName: string;
  inviterName: string;
  invitedUserName: string;
  /** True if the invitee is brand-new and the email should carry an
   *  onboarding "set your password" link via a password-reset token. */
  isNewUser: boolean;
  /** Raw token. Required when isNewUser is true. */
  onboardingToken?: string;
  /** TTL for the onboarding link, in minutes. */
  onboardingExpiresInMinutes?: number;
}

/**
 * Enqueue a "you've been invited" email to a freshly-added org member.
 * For new users, includes a "set your password" link (via the same
 * password-reset token machinery). For users who already had an account
 * and are merely joining an additional org, just announces the new
 * org membership with a login link.
 */
export async function sendMemberInvitationEmail(
  params: MemberInvitationEmailParams,
): Promise<boolean> {
  const {
    to,
    orgName,
    inviterName,
    invitedUserName,
    isNewUser,
    onboardingToken,
    onboardingExpiresInMinutes,
  } = params;

  const loginUrl = `${spaBase()}/login`;
  // For brand-new invitees we have an onboarding token: link directly to
  // /password-reset?token=... so they set their first password in one click.
  // For users who already had an account, link them to the SAME page WITHOUT
  // a token — that surface drops into the "request a reset link" form so a
  // forgotten password is one button away, no manual "click forgot password
  // on the login screen" detour. (2026-06-11 follow-up to the invite-flow
  // incident: the bare login-only existing-user email was confusing folks
  // who had old accounts and forgotten passwords.)
  const setupUrl =
    isNewUser && onboardingToken
      ? `${spaBase()}/password-reset?token=${encodeURIComponent(onboardingToken)}`
      : null;
  const forgotUrl = `${spaBase()}/password-reset`;

  const safeOrg = escapeHtml(orgName);
  const safeInviter = escapeHtml(inviterName);
  const safeName = escapeHtml(invitedUserName);
  const safeSetup = setupUrl ? escapeHtml(setupUrl) : null;
  const safeLogin = escapeHtml(loginUrl);
  const safeForgot = escapeHtml(forgotUrl);
  const ttl = onboardingExpiresInMinutes ?? 60;

  const subject = `${inviterName} invited you to ${orgName} on BigBlueBam`;
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111;">
<h2>You've been added to ${safeOrg}</h2>
<p>Hi ${safeName},</p>
<p>${safeInviter} has invited you to collaborate on <strong>${safeOrg}</strong> in BigBlueBam.</p>
${
  safeSetup
    ? `<p>To get started, set your password using the button below. This link expires in ${ttl} minutes.</p>
<p>
  <a href="${safeSetup}"
     style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">
    Set your password
  </a>
</p>
<p>Or copy this link into your browser:<br/><code>${safeSetup}</code></p>`
    : `<p>Use your existing BigBlueBam login to access the new organization.</p>
<p>
  <a href="${safeLogin}"
     style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;">
    Open BigBlueBam
  </a>
</p>
<p style="margin-top:18px;font-size:13px;color:#444;">
  Forgot your password?
  <a href="${safeForgot}" style="color:#2563eb;">Reset it here</a> — we'll
  email you a link to set a new one.
</p>`
}
<p style="color:#666;font-size:12px;">If you weren't expecting this invitation, you can safely ignore this email.</p>
</body></html>`;

  const text = `Hi ${invitedUserName},

${inviterName} has invited you to collaborate on ${orgName} in BigBlueBam.

${
  setupUrl
    ? `Get started by setting your password (link expires in ${ttl} minutes):\n${setupUrl}`
    : `Sign in with your existing account:\n${loginUrl}\n\nForgot your password? Reset it here:\n${forgotUrl}`
}

If you weren't expecting this invitation, you can safely ignore this email.`;

  try {
    await getQueue().add(
      'member-invitation',
      { to, subject, html, text },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
    return await isSmtpConfigured();
  } catch {
    return false;
  }
}
