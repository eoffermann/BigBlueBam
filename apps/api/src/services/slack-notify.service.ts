import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { slackIntegrations } from '../db/schema/slack-integrations.js';
import { taskUrl } from '../lib/urls.js';

// ─────────────────────────────────────────────────────────────────────────
// Slack outbound notifications
// ─────────────────────────────────────────────────────────────────────────
// Fires fire-and-forget HTTP POSTs to a project's configured Slack
// incoming webhook. We intentionally NEVER throw out of this module: Slack
// being down, a webhook URL being revoked, or even the integration row
// not existing should all be silent no-ops from the caller's perspective.
//
// Caller pattern (from task/sprint services):
//   postToSlack(projectId, { event_type: 'task.created', text, blocks }).catch(() => {});
//
// The per-event boolean flags on slack_integrations gate which event
// kinds actually go out, so admins can e.g. opt into task.created but
// silence sprint events.

export type SlackEventType =
  | 'task.created'
  | 'task.completed'
  | 'sprint.started'
  | 'sprint.completed';

export interface SlackMessage {
  event_type: SlackEventType;
  text: string;
  blocks?: unknown[];
}

function flagFor(
  event: SlackEventType,
  row: { notify_on_task_created: boolean; notify_on_task_completed: boolean; notify_on_sprint_started: boolean; notify_on_sprint_completed: boolean },
): boolean {
  switch (event) {
    case 'task.created':
      return row.notify_on_task_created;
    case 'task.completed':
      return row.notify_on_task_completed;
    case 'sprint.started':
      return row.notify_on_sprint_started;
    case 'sprint.completed':
      return row.notify_on_sprint_completed;
  }
}

export async function postToSlack(
  projectId: string,
  message: SlackMessage,
): Promise<void> {
  try {
    const [integration] = await db
      .select()
      .from(slackIntegrations)
      .where(eq(slackIntegrations.project_id, projectId))
      .limit(1);

    if (!integration) return;
    if (!integration.enabled) return;
    if (!flagFor(message.event_type, integration)) return;

    const body: Record<string, unknown> = { text: message.text };
    if (message.blocks) body.blocks = message.blocks;

    const res = await fetch(integration.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error('[slack-notify] Slack webhook returned non-OK status', {
        projectId,
        event: message.event_type,
        status: res.status,
      });
    }
  } catch (err) {
    console.error('[slack-notify] postToSlack failed', {
      projectId,
      event: message.event_type,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Build a deep link to a task in Bam (used as the "view" link in Slack messages). */
export function taskDeepLink(projectId: string, taskId: string): string {
  // Delegate to the single normalized builder so the /b3 mount + PUBLIC_URL
  // handling lives in exactly one place (lib/urls.ts).
  return taskUrl(projectId, taskId);
}
