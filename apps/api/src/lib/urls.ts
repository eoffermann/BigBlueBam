// ---------------------------------------------------------------------------
// URL builders for deep-links into the Bam SPA.
//
// Used by Bolt event payloads, notifications, Slack, and anywhere else we
// need to hand off a canonical link to a Bam entity. The base URL comes from
// env.FRONTEND_URL (default `http://localhost/b3`) so it stays consistent with
// the existing slack-notify.service.ts / email-queue.ts link building.
// ---------------------------------------------------------------------------

import { env } from '../env.js';

/**
 * Bam SPA base URL. Normalizes env.FRONTEND_URL so the result ALWAYS ends
 * at the SPA mount point (`/b3`), regardless of whether the operator set
 * FRONTEND_URL to the site root (https://example.com) or the SPA mount
 * (https://example.com/b3). Without this, a deploy that misconfigured
 * FRONTEND_URL would emit links like https://example.com/password-reset
 * — which the marketing site happily renders as its homepage, taking
 * the user nowhere near the password-reset form. (The 2026-06-11
 * invite-flow incident.)
 *
 * The SPA mount path comes from nginx (`location /b3/`). Keep this in
 * sync if that mount ever moves.
 */
const SPA_MOUNT = '/b3';

function base(): string {
  const raw = env.FRONTEND_URL.replace(/\/+$/, '');
  if (raw.endsWith(SPA_MOUNT)) return raw;
  return `${raw}${SPA_MOUNT}`;
}

/** Site/marketing root — for the rare case we need to link there. */
export function siteBase(): string {
  return env.FRONTEND_URL.replace(/\/+$/, '').replace(new RegExp(`${SPA_MOUNT}$`), '');
}

/** The Bam SPA base (`https://host/b3`). Exported so the email-queue and
 *  other link builders use exactly one normalized form. */
export function spaBase(): string {
  return base();
}

export function taskUrl(projectId: string, taskId: string): string {
  return `${base()}/projects/${projectId}/board?task=${taskId}`;
}

export function projectUrl(projectId: string): string {
  return `${base()}/projects/${projectId}`;
}

export function sprintUrl(projectId: string, sprintId: string): string {
  return `${base()}/projects/${projectId}/sprints/${sprintId}`;
}

export function epicUrl(projectId: string, epicId: string): string {
  return `${base()}/projects/${projectId}/epics/${epicId}`;
}
