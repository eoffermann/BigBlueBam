// Bastion Drizzle schema barrel. 35 bastion_* tables mirroring migrations 0274-0278 (spec 4.1,
// enumerated in 4.1.1), with the generated per-table RLS policies of 0280 and the hardened
// probe/resolver definer functions of 0279. CHECK constraints, partial and NULLS NOT DISTINCT
// unique indexes, and the four-path immutability triggers live only in the migrations. Cross-app
// refs (bin, bond, beacon, agent_proposals, Bam tasks) are plain uuid columns with no
// cross-schema FK. The Bam-owned github_pr_events table (0273) lives in apps/api.

// Shared BBB table stubs (auth, users, orgs) - FK targets only.
export {
  organizations,
  users,
  projects,
  sessions,
  apiKeys,
  organizationMemberships,
  projectMemberships,
  permissionGroups,
  accountGroupMemberships,
  impersonationSessions,
} from './bbb-refs.js';

// Frameworks and controls (migration 0274, tables 1-7)
export { bastionFrameworks } from './bastion-frameworks.js';
export { bastionControls } from './bastion-controls.js';
export { bastionControlRequirements } from './bastion-control-requirements.js';
export { bastionAssertions } from './bastion-assertions.js';
export { bastionCompileRuns } from './bastion-compile-runs.js';
export { bastionOrgSettings } from './bastion-org-settings.js';
export { bastionAuditLog } from './bastion-audit-log.js';

// Evaluation and evidence (migration 0275, tables 8-22)
export { bastionEvaluationRuns } from './bastion-evaluation-runs.js';
export { bastionEvidenceObjects } from './bastion-evidence-objects.js';
export { bastionObjectIntents } from './bastion-object-intents.js';
export { bastionEvidenceSnapshots } from './bastion-evidence-snapshots.js';
export { bastionManualEvidence } from './bastion-manual-evidence.js';
export { bastionManualEvidenceLinks } from './bastion-manual-evidence-links.js';
export { bastionEvidenceFeeds } from './bastion-evidence-feeds.js';
export { bastionFeedKeys } from './bastion-feed-keys.js';
export { bastionFeedRecords } from './bastion-feed-records.js';
export { bastionPersonalData } from './bastion-personal-data.js';
export { bastionIngestEvents } from './bastion-ingest-events.js';
export { bastionOutbox } from './bastion-outbox.js';
export { bastionLedgerEntries } from './bastion-ledger-entries.js';
export { bastionLedgerSeals } from './bastion-ledger-seals.js';
export { bastionLedgerRestores } from './bastion-ledger-restores.js';

// Gaps, drift, fixes, exceptions, policies (migration 0276, tables 23-28)
export { bastionDriftEvents } from './bastion-drift-events.js';
export { bastionGaps } from './bastion-gaps.js';
export { bastionFixDrafts } from './bastion-fix-drafts.js';
export { bastionExceptions } from './bastion-exceptions.js';
export { bastionPolicies } from './bastion-policies.js';
export { bastionPolicyAttestations } from './bastion-policy-attestations.js';

// Questionnaires (migration 0277, tables 29-31)
export { bastionQuestionnaires } from './bastion-questionnaires.js';
export { bastionQuestionnaireItems } from './bastion-questionnaire-items.js';
export { bastionAnswerLibrary } from './bastion-answer-library.js';

// Sharing (migration 0278, tables 32-35)
export { bastionAuditorRooms } from './bastion-auditor-rooms.js';
export { bastionAuditorAccessLog } from './bastion-auditor-access-log.js';
export { bastionAuditorRequests } from './bastion-auditor-requests.js';
export { bastionExportPackets } from './bastion-export-packets.js';
// Durable "this notice already went out" markers (migration 0287, issue #243)
export { bastionNoticeMarkers } from './bastion-notice-markers.js';
