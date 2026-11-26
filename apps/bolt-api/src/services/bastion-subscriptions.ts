/**
 * The Bastion dispatch subscription set (Bastion spec 8.2), split out with NO env import so the
 * suite can assert it directly. bastion-dispatch-hook.ts imports these.
 *
 * Static: Bastion consumes platform `proposal.decided`, only to detect a Bastion proposal decided
 * outside Bastion (spec 2.8; reconciled at M6). The dispatch hook narrows it on the payload with
 * bastionConsumesEvent (@bigbluebam/shared): only `bastion.*` proposed actions are forwarded,
 * never every org's approval traffic (issue #206).
 *
 * Dynamic: a machine feed with source_kind `bolt_event` (spec 3.5) names one (source, event_type)
 * pair. Those are forwarded only when the org's binding set `bastion:feed-bindings:<org_id>` in
 * Redis contains `<source>:<event_type>`. Unlike Bursar's advisory gate, a MISSING key forwards
 * nothing dynamic: failing open here would forward every event of every org to Bastion.
 */
export const BASTION_SUBSCRIPTIONS = new Set<string>(['platform:proposal.decided']);

/** True for the static subscriptions (forwarded for every org). Pure; tested. */
export function isBastionSubscribed(source: string, eventType: string): boolean {
  return BASTION_SUBSCRIPTIONS.has(`${source}:${eventType}`);
}

/** Bastion never consumes its own events (a feed bound to a bastion event would loop). */
export function isBastionFeedCandidate(source: string): boolean {
  return source !== 'bastion';
}

export const BASTION_FEED_BINDINGS_KEY = (orgId: string) => `bastion:feed-bindings:${orgId}`;

export const BASTION_SUBSCRIPTION_COUNT = BASTION_SUBSCRIPTIONS.size;
