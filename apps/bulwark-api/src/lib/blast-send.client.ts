import { env } from '../env.js';

// Transactional-send transport (spec D6 / reuse ledger line 710). Bulwark never sends SMTP
// itself; a legally-required notice/chase is POSTed to blast-api's internal transactional-send
// route, which resolves the deterministic recipient to an address and enqueues the platform
// email queue (bypassing blast_unsubscribes). Guarded by INTERNAL_SERVICE_SECRET.
//
// The recipient is a DETERMINISTIC entity ref (THEME E): the contract counterparty or the
// vendor tier's vendor. Bulwark never lets the model pick a recipient. A non-2xx response is
// surfaced so the caller can annotate the proposal (e.g. recipient_unresolved).

export type TransactionalRecipient =
  | { email: string }
  | { type: 'bond.contact' | 'bond.company'; id: string };

export interface TransactionalSendResult {
  sent: boolean;
  status: number;
  annotation?: string;
}

export async function sendTransactional(args: {
  orgId: string;
  recipient: TransactionalRecipient;
  subject: string;
  bodyMarkdown: string;
  sourceApp?: string;
}): Promise<TransactionalSendResult> {
  const base = env.BLAST_API_INTERNAL_URL?.replace(/\/+$/, '');
  const secret = env.INTERNAL_SERVICE_SECRET;
  if (!base || !secret) {
    // No transport configured: report not-sent so the caller annotates rather than silently
    // claiming delivery.
    return { sent: false, status: 0, annotation: 'transactional_transport_unconfigured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/internal/transactional-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      signal: controller.signal,
      body: JSON.stringify({
        org_id: args.orgId,
        recipient: args.recipient,
        subject: args.subject,
        body_markdown: args.bodyMarkdown,
        transactional: true,
        source_app: args.sourceApp ?? 'bulwark',
      }),
    });
    if (res.status === 422) return { sent: false, status: 422, annotation: 'recipient_unresolved' };
    if (!res.ok) return { sent: false, status: res.status, annotation: `blast_${res.status}` };
    return { sent: true, status: res.status };
  } catch {
    return { sent: false, status: 0, annotation: 'transactional_transport_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
