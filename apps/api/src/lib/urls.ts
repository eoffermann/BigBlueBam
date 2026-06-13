// ---------------------------------------------------------------------------
// URL builders for deep-links into the Bam SPA.
//
// Used by Bolt event payloads, notifications, Slack, and anywhere else we
// need to hand off a canonical link to a Bam entity. The base URL comes from
// env.PUBLIC_URL (the bare site root, default `http://localhost`); the Bam SPA
// mount (`/b3`) is appended here.
// ---------------------------------------------------------------------------

import { env } from '../env.js';

/**
 * Bam SPA base URL. PUBLIC_URL is the bare site root; we append the SPA mount
 * (`/b3`) here so the result ALWAYS ends at the SPA. The `endsWith` guard
 * keeps it correct even if an operator mistakenly set PUBLIC_URL to the SPA
 * mount — without it a stray link like https://example.com/password-reset
 * lands on the marketing homepage instead of the reset form (the 2026-06-11
 * invite-flow incident).
 *
 * The SPA mount path comes from nginx (`location /b3/`). Keep this in
 * sync if that mount ever moves.
 */
const SPA_MOUNT = '/b3';

function base(): string {
  const raw = env.PUBLIC_URL.replace(/\/+$/, '');
  if (raw.endsWith(SPA_MOUNT)) return raw;
  return `${raw}${SPA_MOUNT}`;
}

/** Site/marketing root — for the rare case we need to link there. */
export function siteBase(): string {
  return env.PUBLIC_URL.replace(/\/+$/, '').replace(new RegExp(`${SPA_MOUNT}$`), '');
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
