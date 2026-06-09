// Lightweight BullMQ producer for the shared `email` queue.
//
// The worker service (apps/worker) owns actual SMTP delivery via
// processEmailJob. The API only enqueues jobs here. Job shape must match
// apps/worker/src/jobs/email.job.ts → EmailJobData.
//
// We expose sendGuestInvitationEmail as the single caller for P1-30. The
// function returns `email_sent` = true only when the job was successfully
// enqueued AND SMTP is configured. When SMTP is unset, we still enqueue so
// the worker will log it, but we return email_sent = false so the API
// response accurately reflects that the invitee was not actually emailed.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../env.js';

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

export function isSmtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST);
}

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
 * Returns true if the job was successfully enqueued, false otherwise.
 * Callers should still treat SMTP-unconfigured as `email_sent: false`.
 */
export async function sendGuestInvitationEmail(
  params: GuestInvitationEmailParams,
): Promise<boolean> {
  const { to, token, orgName, inviterName } = params;
  const acceptUrl = `${env.FRONTEND_URL.replace(/\/$/, '')}/guests/accept/${token}`;

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
    return isSmtpConfigured();
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
  const verifyUrl = `${env.FRONTEND_URL.replace(/\/$/, '')}/verify-email/${token}`;

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
    return isSmtpConfigured();
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
    return isSmtpConfigured();
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
  const resetUrl = `${env.FRONTEND_URL.replace(/\/$/, '')}/password-reset?token=${encodeURIComponent(token)}`;

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
    return isSmtpConfigured();
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

  const loginUrl = `${env.FRONTEND_URL.replace(/\/$/, '')}/login`;
  const setupUrl =
    isNewUser && onboardingToken
      ? `${env.FRONTEND_URL.replace(/\/$/, '')}/password-reset?token=${encodeURIComponent(onboardingToken)}`
      : null;

  const safeOrg = escapeHtml(orgName);
  const safeInviter = escapeHtml(inviterName);
  const safeName = escapeHtml(invitedUserName);
  const safeSetup = setupUrl ? escapeHtml(setupUrl) : null;
  const safeLogin = escapeHtml(loginUrl);
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
</p>`
}
<p style="color:#666;font-size:12px;">If you weren't expecting this invitation, you can safely ignore this email.</p>
</body></html>`;

  const text = `Hi ${invitedUserName},

${inviterName} has invited you to collaborate on ${orgName} in BigBlueBam.

${
  setupUrl
    ? `Get started by setting your password (link expires in ${ttl} minutes):\n${setupUrl}`
    : `Sign in with your existing account:\n${loginUrl}`
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
    return isSmtpConfigured();
  } catch {
    return false;
  }
}
