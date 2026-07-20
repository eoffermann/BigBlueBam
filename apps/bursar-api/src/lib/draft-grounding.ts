/**
 * Draft grounding builder (spec 5.7, M8). The ONLY way a draft's grounding_set is assembled.
 *
 * A draft (clarification or negotiation brief) is the one artifact that leaves the building, so its
 * grounding must be provably confined: it can select lines of EXACTLY ONE offer and nodes of
 * EXACTLY ONE request, nothing else. Confinement is enforced structurally - the builder takes an
 * offer_id and a request_id and passes those, and only those, to two narrow queries; it has no
 * path to a third id, a different offer, or another request's nodes. grounding_set is written from
 * this output, so test/draft-grounding.test.ts asserts THE BUILDER, not a downstream serializer.
 *
 * No db/env import: the source is injected so the test proves the confinement against an in-memory
 * store that holds rows for MANY offers/requests and confirms only the target's rows come back.
 */

export interface GroundingLine {
  id: string;
  ordinal: number;
  raw_text: string;
  line_role: string | null;
  unit: string | null;
  quantity: string | number | null;
}

export interface GroundingNode {
  id: string;
  ordinal: number;
  title: string;
  normative_strength: string;
}

export interface DraftGroundingSource {
  /** Lines of EXACTLY this offer in this org. The DB store scopes by (organization_id, offer_id). */
  offerLines(orgId: string, offerId: string): Promise<GroundingLine[]>;
  /** Nodes of EXACTLY this request in this org. The DB store scopes by (organization_id, request_id). */
  requestNodes(orgId: string, requestId: string): Promise<GroundingNode[]>;
}

export interface DraftGrounding {
  request_id: string;
  offer_id: string | null;
  nodes: GroundingNode[];
  lines: GroundingLine[];
}

/**
 * Build the grounding for a draft. Selects ONLY:
 *   - nodes of `requestId`,
 *   - lines of `offerId` (when an offer is in scope; null offer -> no lines).
 * There is no parameter, branch, or fallback that reaches any other offer or request. A caller that
 * wants a different offer's lines must pass that offer's id here, which is itself access-checked at
 * the route; the builder cannot be tricked into widening.
 */
export async function buildDraftGrounding(
  source: DraftGroundingSource,
  orgId: string,
  args: { offerId: string | null; requestId: string },
): Promise<DraftGrounding> {
  const nodes = await source.requestNodes(orgId, args.requestId);
  const lines = args.offerId ? await source.offerLines(orgId, args.offerId) : [];
  return {
    request_id: args.requestId,
    offer_id: args.offerId,
    nodes,
    lines,
  };
}
