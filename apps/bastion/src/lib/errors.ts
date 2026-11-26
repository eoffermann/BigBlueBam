import { ApiError } from './api';

// Plain-language error text for the default views (spec 6.2; issue #194). A server message is
// shown as-is only when it is already written for people; permission and sign-in refusals carry
// identifiers (for example "Permission denied: bastion.framework.write"), so they are replaced by
// a sentence, and the code goes to the Technical details disclosure only.

const PERMISSION_CODES = new Set(['PERMISSION_DENIED', 'FORBIDDEN', 'INSUFFICIENT_PERMISSIONS']);

export function friendlyError(err: unknown): string | null {
  if (!err) return null;
  if (!(err instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (err.code === 'SESSION_REQUIRED') {
    return 'Only a person signed in to BigBlueBam in the browser can do this. Sign in again and retry.';
  }
  if (err.code === 'IMPERSONATION_NOT_ALLOWED') {
    return 'You are viewing Bastion as another person. Only that person can do this.';
  }
  if (err.status === 401) return 'Your session has ended. Sign in again and retry.';
  if (err.status === 403 || PERMISSION_CODES.has(err.code)) {
    return 'You do not have permission to do this. Ask an admin of your organization.';
  }
  if (err.status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
  return err.message;
}

/** What the Technical details disclosure shows (codes are fine there, never on the default view). */
export function technicalDetails(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const parts = [`Code: ${err.code}`, `Status: ${err.status}`];
  if (err.requestId) parts.push(`Request: ${err.requestId}`);
  return parts.join(' | ');
}
