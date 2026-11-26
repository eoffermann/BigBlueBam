import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/**
 * Phase 6: GitHub integration helpers.
 *
 * This module is intentionally framework-agnostic — it exports pure
 * functions that the routes and tests both consume. Keeping HMAC
 * verification and ref parsing out of the Fastify handler makes them
 * trivial to unit test without spinning up the server.
 */

/**
 * Matches Bam task human_ids such as "MAGE-38" or "bbam-1024". GitHub
 * commit messages and PR bodies commonly embed these inline, so we scan
 * for any 2–10 letter prefix followed by a dash and digits. The prefix
 * portion is case-insensitive at the regex level; the caller uppercases
 * the result before looking it up in `tasks.human_id`.
 *
 * Word-boundary anchors keep us from matching URL fragments like
 * "/pull/42-fix" where "ull-42" is not a real ticket.
 */
const TASK_REF_REGEX = /\b([A-Za-z]{2,10}-\d+)\b/g;

/**
 * Extracts all unique task references from a blob of text (commit
 * message, PR title, PR body). Returns uppercased human_ids so the
 * caller can match directly against the stored value, and deduplicates
 * so a PR body that mentions MAGE-38 three times only yields one row.
 */
export function parseTaskRefs(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TASK_REF_REGEX)) {
    seen.add(match[1]!.toUpperCase());
  }
  return [...seen];
}

/**
 * Verifies GitHub's X-Hub-Signature-256 header.
 *
 * GitHub computes `sha256=<hex>` where the hex is an HMAC-SHA256 of the
 * raw request body keyed on the webhook secret that was configured when
 * the webhook was registered. We MUST compare against the raw body
 * bytes, not JSON-reserialized output, or whitespace differences will
 * break verification.
 *
 * Returns true on valid signature, false otherwise. Both the length
 * check and timingSafeEqual protect against timing attacks on the
 * comparison.
 */
export function verifyGithubSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const provided = signatureHeader.slice('sha256='.length);
  const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', secret).update(bodyBuf).digest('hex');

  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Generates a fresh webhook secret: 32 random bytes rendered as 64 hex
 * chars. Long enough that brute-forcing the HMAC is impractical and
 * short enough to copy-paste into GitHub's webhook UI.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Decides which phase (if any) a task should transition to given the
 * incoming PR event. Returns null when no transition should happen.
 *
 * Rules:
 *   - PR opened  → integration.transition_on_pr_open_phase_id   (if set)
 *   - PR merged  → integration.transition_on_pr_merged_phase_id (if set)
 *   - any other PR action → no transition
 *
 * A merged PR arrives as action='closed' + merged=true, hence the
 * explicit merged flag below.
 */
export function decidePrTransition(
  action: string | undefined,
  merged: boolean,
  config: {
    transition_on_pr_open_phase_id: string | null;
    transition_on_pr_merged_phase_id: string | null;
  },
): string | null {
  if (action === 'opened') return config.transition_on_pr_open_phase_id ?? null;
  if (action === 'closed' && merged) return config.transition_on_pr_merged_phase_id ?? null;
  return null;
}

/**
 * Reads `hook.events` from a `ping` delivery (migration 0273, Bastion spec 3.1/8.4). Returns
 * the de-duplicated, sorted event names, or null when the payload carries no usable list, so
 * the caller leaves `github_integrations.subscribed_events` as it was (NULL means unknown).
 */
export function extractHookEvents(body: unknown): string[] | null {
  const events = (body as { hook?: { events?: unknown } } | null)?.hook?.events;
  if (!Array.isArray(events)) return null;
  const names = events.filter(
    (e): e is string => typeof e === 'string' && e.length > 0 && e.length <= 64,
  );
  if (names.length === 0) return null;
  return [...new Set(names)].sort();
}

type GithubUser = { login?: string | null } | null | undefined;

interface GithubPrShape {
  number?: number;
  title?: string | null;
  body?: string | null;
  html_url?: string | null;
  merged?: boolean | null;
  merged_at?: string | null;
  merged_by?: GithubUser;
  merge_commit_sha?: string | null;
  updated_at?: string | null;
  user?: GithubUser;
  head?: { sha?: string | null } | null;
  base?: { ref?: string | null } | null;
}

interface GithubReviewShape {
  id?: number;
  state?: string | null;
  submitted_at?: string | null;
  commit_id?: string | null;
  user?: GithubUser;
}

/** One github_pr_events row, minus the server-assigned id/received_at. */
export interface GithubPrEventRow {
  org_id: string;
  integration_id: string;
  project_id: string;
  repo_owner: string;
  repo_name: string;
  delivery_id: string | null;
  event_type: 'pull_request' | 'pull_request_review';
  action: string;
  pr_number: number;
  pr_title: string | null;
  pr_html_url: string | null;
  pr_author_login: string | null;
  base_ref: string | null;
  default_branch: string | null;
  head_sha: string | null;
  merged: boolean;
  merged_at: Date | null;
  merged_by_login: string | null;
  merge_commit_sha: string | null;
  review_id: number | null;
  review_state: string | null;
  reviewer_login: string | null;
  review_submitted_at: Date | null;
  review_commit_sha: string | null;
  task_refs: string[];
  occurred_at: Date;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Builds the github_pr_events row for one pull_request or pull_request_review delivery
 * (Bastion spec 3.1/8.4): every delivery is recorded whatever its task mention, so the
 * change-management probes see every merge and every review. Returns null for any other
 * event or a payload without a PR number. `now` is the receive time, used when GitHub sends
 * no timestamp of its own.
 */
export function buildPrEventRow(
  event: string,
  body: unknown,
  ctx: {
    org_id: string;
    integration_id: string;
    project_id: string;
    repo_owner: string;
    repo_name: string;
    delivery_id: string | null;
    now: Date;
  },
): GithubPrEventRow | null {
  if (event !== 'pull_request' && event !== 'pull_request_review') return null;
  const payload = (body ?? {}) as {
    action?: string;
    pull_request?: GithubPrShape;
    review?: GithubReviewShape;
    repository?: { default_branch?: string | null };
  };
  const pr = payload.pull_request;
  if (!pr || typeof pr.number !== 'number') return null;
  const review = event === 'pull_request_review' ? payload.review : undefined;
  const merged = pr.merged === true;
  const mergedAt = merged ? toDate(pr.merged_at) : null;
  const reviewSubmittedAt = toDate(review?.submitted_at);
  const occurredAt =
    event === 'pull_request_review'
      ? (reviewSubmittedAt ?? ctx.now)
      : (mergedAt ?? toDate(pr.updated_at) ?? ctx.now);
  return {
    org_id: ctx.org_id,
    integration_id: ctx.integration_id,
    project_id: ctx.project_id,
    repo_owner: ctx.repo_owner,
    repo_name: ctx.repo_name,
    delivery_id: clip(ctx.delivery_id, 100),
    event_type: event,
    action: clip(payload.action, 32) ?? 'unknown',
    pr_number: pr.number,
    pr_title: pr.title ?? null,
    pr_html_url: pr.html_url ?? null,
    pr_author_login: clip(pr.user?.login, 200),
    base_ref: clip(pr.base?.ref, 255),
    default_branch: clip(payload.repository?.default_branch, 255),
    head_sha: clip(pr.head?.sha, 64),
    merged,
    merged_at: mergedAt,
    merged_by_login: merged ? clip(pr.merged_by?.login, 200) : null,
    merge_commit_sha: merged ? clip(pr.merge_commit_sha, 64) : null,
    review_id: typeof review?.id === 'number' ? review.id : null,
    review_state: clip(review?.state?.toLowerCase(), 32),
    reviewer_login: clip(review?.user?.login, 200),
    review_submitted_at: reviewSubmittedAt,
    review_commit_sha: clip(review?.commit_id, 64),
    task_refs: parseTaskRefs(`${pr.title ?? ''}\n${pr.body ?? ''}`),
    occurred_at: occurredAt,
  };
}
