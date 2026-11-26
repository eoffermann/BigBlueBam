// The canonical can_access entity_type allowlist (AGENTIC_TODO §11). ONE list: the api's
// visibility service dispatches on it (apps/api/src/services/visibility.service.ts re-exports it
// as SUPPORTED_ENTITY_TYPES), and the MCP can_access tool's description is generated from it
// (apps/mcp-server/src/tools/visibility-tools.ts, pinned by a test). Adding an entity type means
// adding it here, adding its preflight branch in the api, and regenerating the description with
// `node scripts/gen-can-access-description.mjs`. Pure; browser-safe.

export const VISIBILITY_ENTITY_TYPES = [
  'bam.task',
  'bam.project',
  'bam.sprint',
  'helpdesk.ticket',
  'bond.deal',
  'bond.contact',
  'bond.company',
  'brief.document',
  'beacon.entry',
  'blueprint.diagram',
  'blueprint.node',
  // Banter Feed entity-type registration (banter-feed-design-document.md §16)
  'banter.message',
  'banter.channel',
  'bearing.goal',
  'bearing.kr',
  'board.board',
  'book.event',
  'bill.invoice',
  'blank.form',
  'bolt.rule',
  'bin.asset',
  'bin.folder',
  'bay.asset',
  // Blip telemetry entity-type registration (BigBlueBam_Blip_Design_Document.md §2)
  'blip.tracked_app',
  'blip.saved_view',
  // Braid person-source + golden-profile registration (APP_DESIGN_braid.md §2.5)
  'bill.client',
  'book.event_attendee',
  'braid.profile',
  'braid.identity',
  // Bulwark contract-obligation-monitor registration (APP_DESIGN_bulwark.md §2.5)
  'bulwark.contract',
  'bulwark.obligation',
  'bulwark.deadline',
  // Burn margin/envelope-attribution monitor registration (APP_DESIGN_burn.md 2.4 point 4)
  'burn.engagement',
  'burn.deliverable',
  // Bursar absence-detection / bid-leveling registration (APP_DESIGN_bursar.md §16.3)
  'bill.expense',
  'bursar.vendor',
  'bursar.request',
  'bursar.offer',
  'bursar.award',
  'bursar.mismatch',
  // Bastion continuous-compliance registration (APP_DESIGN_bastion.md 8.3, 8.4; M6)
  'bastion.control',
  'bastion.manual_evidence',
  'bastion.policy',
  'bastion.questionnaire',
  'bastion.fix_draft',
  'bastion.exception',
  // Platform rows cited by compliance probes (#227): Bastion maps its probe refs
  // (github_pr_event, api_key, user) onto these, so a citation passes can_access like any other.
  'bam.github_pr_event',
  'bam.api_key',
  'bam.user',
] as const;

export type VisibilityEntityType = (typeof VISIBILITY_ENTITY_TYPES)[number];

/** The can_access MCP tool description, built from the list above. */
export function canAccessToolDescription(types: readonly string[] = VISIBILITY_ENTITY_TYPES): string {
  const lead =
    'Preflight a visibility check. Returns { allowed, reason } for whether asker_user_id can see (entity_type, entity_id). Agents that surface cross-app results into shared channels MUST call this for every cited entity and filter out anything that is not allowed.';
  const tail = "Unsupported types return reason='unsupported_entity_type' (with a supported_entity_types hint) and MUST NOT be surfaced.";
  return `${lead} Supported entity_type values: ${types.join(', ')}. ${tail}`;
}
