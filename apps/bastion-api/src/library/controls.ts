// The internal control catalog (spec 2.1). One control per thing an organization actually does;
// the SOC 2 and ISO 27001 requirement lists (soc2.ts, iso27001.ts) point at these by
// `control_key`, and two requirements naming the same key share one control. That is the static
// crosswalk.
//
// Wording is ours. Titles and summaries are plain-language descriptions written for this product;
// they are not the official AICPA or ISO text.
//
// suggested_assertions are probe checks from the closed menu (probe-catalog.ts).
// suggested_manual_evidence are what a person can upload or state when no probe can see it.
// The deterministic compile (spec 2.1 step 5) proposes both verbatim.

import type { BastionManualEvidenceSpec, BastionProbeKey } from '@bigbluebam/shared';

export interface ProbeSuggestion {
  probe_key: BastionProbeKey;
  params?: Record<string, unknown>;
  predicate?: Record<string, unknown>;
  plain_statement: string;
}

export interface ManualSuggestion {
  spec: BastionManualEvidenceSpec;
  plain_statement: string;
}

export interface LibraryControl {
  control_key: string;
  title: string;
  plain_summary: string;
  category: string;
  /** 1 (low) to 5 (high); feeds gap ranking (spec 2.3). */
  risk_weight: number;
  suggested_assertions: ProbeSuggestion[];
  suggested_manual_evidence: ManualSuggestion[];
}

const file = (title: string, description: string, cadence_days: number): BastionManualEvidenceSpec => ({
  title,
  description,
  kind: 'file',
  cadence_days,
});
const statement = (title: string, description: string, cadence_days: number): BastionManualEvidenceSpec => ({
  title,
  description,
  kind: 'attestation_statement',
  cadence_days,
});

export const LIBRARY_CONTROLS: readonly LibraryControl[] = [
  /* ── Governance and risk ─────────────────────────────────────────────── */
  {
    control_key: 'governance.security_program',
    title: 'Someone owns the security program',
    plain_summary:
      'A named person is responsible for security, sets its goals for the year and keeps the everyday procedures written down.',
    category: 'governance',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement(
          'Security owner and yearly goals',
          'Name the person who owns security and list this year\'s security goals.',
          365,
        ),
        plain_statement: 'A named owner sets and reviews the security goals every year.',
      },
    ],
  },
  {
    control_key: 'governance.leadership_oversight',
    title: 'Leadership reviews security',
    plain_summary: 'The people running the company look at security at least once a year and act on what they find.',
    category: 'governance',
    risk_weight: 2,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Leadership security review notes', 'Notes or minutes from the latest leadership meeting that covered security.', 365),
        plain_statement: 'Leadership reviewed security in the last year.',
      },
    ],
  },
  {
    control_key: 'governance.org_structure',
    title: 'Roles and reporting lines are written down',
    plain_summary: 'Who does what, and who answers to whom, is written down and kept up to date.',
    category: 'governance',
    risk_weight: 2,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Organization chart', 'A current organization chart or list of roles and responsibilities.', 365),
        plain_statement: 'A current organization chart shows roles and reporting lines.',
      },
    ],
  },
  {
    control_key: 'risk.assessment',
    title: 'Risks are assessed every year',
    plain_summary:
      'Once a year, and whenever something big changes, the company lists what could go wrong, including fraud, and decides what to do about each risk.',
    category: 'risk',
    risk_weight: 4,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Risk register', 'The current list of risks with an owner and a decision for each.', 365),
        plain_statement: 'A risk register was reviewed in the last year.',
      },
    ],
  },
  {
    control_key: 'compliance.legal_requirements',
    title: 'Legal and contract duties are tracked',
    plain_summary:
      'Laws, contracts and licences that touch information are listed, and important records are kept safe for as long as needed.',
    category: 'compliance',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Legal and contract obligations list', 'The list of laws, contracts and licences that apply to your information.', 365),
        plain_statement: 'A list of legal and contract duties is kept current.',
      },
    ],
  },
  {
    control_key: 'compliance.independent_review',
    title: 'Security is checked independently',
    plain_summary:
      'Someone who did not build the controls checks them regularly, and problems found are reported to the people who can fix them.',
    category: 'compliance',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Independent review report', 'The latest internal or external review of your security controls.', 365),
        plain_statement: 'An independent review of the controls happened in the last year.',
      },
    ],
  },
  {
    control_key: 'policy.security_policy',
    title: 'A security policy exists and people have read it',
    plain_summary:
      'There is a written security policy that is current, visible to everyone, and acknowledged by the people it applies to.',
    category: 'policy',
    risk_weight: 4,
    suggested_assertions: [
      { probe_key: 'policy.current', plain_statement: 'The security policy is active, visible and reviewed within the year.' },
      { probe_key: 'policy.attested', plain_statement: 'Everyone required has acknowledged the current security policy.' },
    ],
    suggested_manual_evidence: [],
  },

  /* ── People ──────────────────────────────────────────────────────────── */
  {
    control_key: 'hr.screening',
    title: 'People are checked before they join',
    plain_summary: 'New staff and contractors go through background checks that fit the role and local law.',
    category: 'people',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Background check statement', 'Confirm that everyone who joined this year was checked before starting.', 365),
        plain_statement: 'Everyone who joined was checked before starting.',
      },
    ],
  },
  {
    control_key: 'hr.terms_and_nda',
    title: 'Staff agree to security duties and confidentiality',
    plain_summary:
      'Employment and contractor agreements include security duties, a code of conduct and confidentiality, including after someone leaves.',
    category: 'people',
    risk_weight: 2,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Signed agreement template', 'The agreement template people sign, showing the security and confidentiality terms.', 365),
        plain_statement: 'Everyone signs an agreement with security and confidentiality terms.',
      },
    ],
  },
  {
    control_key: 'hr.training',
    title: 'Everyone gets security awareness training',
    plain_summary: 'Everyone learns how to spot and report security problems when they join and at least once a year after.',
    category: 'people',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Training completion report', 'A report showing who completed security training this year.', 365),
        plain_statement: 'Everyone completed security training in the last year.',
      },
    ],
  },
  {
    control_key: 'hr.disciplinary',
    title: 'There is a fair process when rules are broken',
    plain_summary: 'When someone breaks a security rule there is a known, fair process for what happens next.',
    category: 'people',
    risk_weight: 1,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Disciplinary process statement', 'Describe where the disciplinary process is written down and who runs it.', 365),
        plain_statement: 'A disciplinary process for security breaches is written down.',
      },
    ],
  },

  /* ── Access ──────────────────────────────────────────────────────────── */
  {
    control_key: 'access.offboarding',
    title: 'Access is removed when people leave',
    plain_summary: 'When someone leaves, their keys and sign-ins stop working and company equipment comes back.',
    category: 'access',
    risk_weight: 5,
    suggested_assertions: [
      {
        probe_key: 'access.departed_still_holding',
        plain_statement: 'Nobody who has left still holds a working key or sign-in.',
      },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'access.reviews',
    title: 'Access is reviewed regularly',
    plain_summary: 'Every quarter someone checks who has access to what, and accounts nobody uses are switched off.',
    category: 'access',
    risk_weight: 4,
    suggested_assertions: [
      { probe_key: 'access.dormant_accounts', plain_statement: 'No member has gone 90 days without signing in.' },
    ],
    suggested_manual_evidence: [
      {
        spec: file('Quarterly access review', 'The record of the latest review of who has access to your key systems.', 90),
        plain_statement: 'Access to key systems was reviewed this quarter.',
      },
    ],
  },
  {
    control_key: 'access.least_privilege',
    title: 'Admin rights are kept to a few people',
    plain_summary:
      'People get only the access their job needs, powerful rights are held by very few, and no one person can push through a risky change alone.',
    category: 'access',
    risk_weight: 4,
    suggested_assertions: [
      { probe_key: 'access.privileged_roster', plain_statement: 'At most three people are owners or admins.' },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'access.provisioning',
    title: 'Accounts are granted through a known process',
    plain_summary: 'New accounts and new rights are requested, approved and recorded the same way every time.',
    category: 'access',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Access request process', 'Describe how access is requested and approved, and where approvals are kept.', 365),
        plain_statement: 'Access is granted only through an approved request.',
      },
    ],
  },
  {
    control_key: 'access.remote_work',
    title: 'Remote work follows safe rules',
    plain_summary: 'People working away from the office follow simple rules for networks, screens and devices.',
    category: 'access',
    risk_weight: 2,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Remote work rules', 'Describe the rules people follow when working remotely.', 365),
        plain_statement: 'Remote work rules are written down and shared.',
      },
    ],
  },
  {
    control_key: 'auth.mfa',
    title: 'Two-step sign-in is required',
    plain_summary: 'Signing in to important systems needs a second step, such as a code from a phone, as well as a password.',
    category: 'authentication',
    risk_weight: 5,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file(
          'Two-step sign-in report',
          'A report from your sign-in provider showing two-step sign-in is switched on for everyone.',
          90,
        ),
        plain_statement: 'Two-step sign-in is switched on for every account.',
      },
    ],
  },
  {
    control_key: 'auth.login_monitoring',
    title: 'Unusual sign-in failures are watched',
    plain_summary: 'Bursts of failed sign-ins are noticed and looked into.',
    category: 'authentication',
    risk_weight: 3,
    suggested_assertions: [
      {
        probe_key: 'auth.failed_login_spikes',
        plain_statement: 'No account had 10 or more failed sign-ins in one hour this month.',
      },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'keys.rotation',
    title: 'API keys are replaced and unused ones removed',
    plain_summary: 'Keys that let programs sign in are replaced regularly, and keys nobody uses are switched off.',
    category: 'authentication',
    risk_weight: 4,
    suggested_assertions: [
      { probe_key: 'keys.max_age', plain_statement: 'No API key is older than 90 days.' },
      { probe_key: 'keys.unused_active', plain_statement: 'No working API key has gone unused for 60 days.' },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'agents.oversight',
    title: 'AI agents are fenced in and people approve their actions',
    plain_summary: 'Every AI agent has a written list of what it may do, and a person decides on what agents propose.',
    category: 'access',
    risk_weight: 4,
    suggested_assertions: [
      { probe_key: 'agents.policy_coverage', plain_statement: 'Every AI agent has a rule set and none may use every tool.' },
      {
        probe_key: 'agents.human_approval',
        predicate: { max_expired_undecided: 5 },
        plain_statement: 'People decide agent proposals; no more than five expired undecided this month.',
      },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'platform.superuser_oversight',
    title: 'Hosting platform staff access is watched',
    plain_summary: 'Actions the hosting platform\'s own staff take inside your organization are recorded and reviewed.',
    category: 'access',
    risk_weight: 2,
    suggested_assertions: [
      {
        probe_key: 'platform.superuser_access',
        predicate: { max_actions: 50 },
        plain_statement: 'Hosting platform staff took few actions inside the organization this month.',
      },
    ],
    suggested_manual_evidence: [],
  },

  /* ── Change and development ──────────────────────────────────────────── */
  {
    control_key: 'change.peer_review',
    title: 'Code changes are reviewed by a second person',
    plain_summary: 'Every change to production code is approved by someone other than the person who wrote it.',
    category: 'change',
    risk_weight: 5,
    suggested_assertions: [
      {
        probe_key: 'change.merge_reviewed',
        plain_statement: 'Every change merged in the listed repositories was approved by a second person.',
      },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'change.traceability',
    title: 'Code changes trace back to planned work',
    plain_summary: 'Changes to code point at the task that asked for them, so every change has a reason on record.',
    category: 'change',
    risk_weight: 3,
    suggested_assertions: [
      {
        probe_key: 'change.merge_traceable',
        predicate: { min_ratio: 0.9 },
        plain_statement: 'At least 90% of changes merged in the listed repositories mention a task.',
      },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'dev.secure_development',
    title: 'Software is built with security in mind',
    plain_summary:
      'Security needs are part of design, code is written and tested to a guideline, test data is safe, and development, testing and live systems are kept apart.',
    category: 'change',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Secure development guideline', 'The guideline your developers follow for design, coding and testing.', 365),
        plain_statement: 'Developers follow a written secure development guideline.',
      },
    ],
  },
  {
    control_key: 'projects.security',
    title: 'Security is part of every project',
    plain_summary: 'New projects and big changes consider security before they start.',
    category: 'change',
    risk_weight: 2,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Project security checklist', 'Describe how security is considered when a project starts.', 365),
        plain_statement: 'Projects consider security before they start.',
      },
    ],
  },
  {
    control_key: 'config.baseline',
    title: 'Systems follow a standard secure setup',
    plain_summary: 'Servers and tools are set up the same safe way, and only approved software is installed.',
    category: 'operations',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Standard setup statement', 'Describe your standard secure setup and how software installs are approved.', 365),
        plain_statement: 'Systems are set up from a standard secure baseline.',
      },
    ],
  },

  /* ── Operations ──────────────────────────────────────────────────────── */
  {
    control_key: 'ops.backups',
    title: 'Backups run and a copy is kept off-site',
    plain_summary: 'Data is backed up every day and a copy is kept somewhere else.',
    category: 'operations',
    risk_weight: 4,
    suggested_assertions: [
      { probe_key: 'ops.backup_fresh', plain_statement: 'A backup finished in the last 26 hours and its off-site copy is current.' },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'ops.restore_testing',
    title: 'Restores are tested',
    plain_summary: 'At least once a year a backup is actually restored to prove it works.',
    category: 'operations',
    risk_weight: 3,
    suggested_assertions: [
      { probe_key: 'ops.restore_tested', plain_statement: 'A backup was restored successfully in the last year.' },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'ops.monitoring',
    title: 'Systems are watched for problems',
    plain_summary: 'Systems are monitored for faults, overload and unusual behavior, and someone is alerted.',
    category: 'operations',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Monitoring statement', 'Describe what is monitored and who gets alerted.', 365),
        plain_statement: 'Key systems are monitored and alerts reach a person.',
      },
    ],
  },
  {
    control_key: 'logging.retention',
    title: 'Logs are kept long enough',
    plain_summary: 'Application logs are kept for at least 90 days so problems can be investigated.',
    category: 'logging',
    risk_weight: 3,
    suggested_assertions: [
      {
        probe_key: 'logging.retention_floor',
        plain_statement: 'Every listed app keeps its logs for at least 90 days.',
      },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'logging.audit_trail',
    title: 'An activity trail is recorded',
    plain_summary: 'Who did what, and when, is recorded with accurate times.',
    category: 'logging',
    risk_weight: 3,
    suggested_assertions: [
      { probe_key: 'logging.audit_trail_alive', plain_statement: 'Activity was recorded in the last 7 days.' },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'automation.reliability',
    title: 'Automations run reliably',
    plain_summary: 'Automated jobs that run the business are documented and rarely fail.',
    category: 'operations',
    risk_weight: 2,
    suggested_assertions: [
      {
        probe_key: 'automation.failure_rate',
        predicate: { max_failure_ratio: 0.05 },
        plain_statement: 'No more than 5% of automation runs failed this month.',
      },
    ],
    suggested_manual_evidence: [],
  },
  {
    control_key: 'vuln.management',
    title: 'Known weaknesses are found and fixed',
    plain_summary: 'Systems are scanned for known weaknesses and the serious ones are fixed quickly.',
    category: 'operations',
    risk_weight: 5,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Vulnerability scan report', 'The latest scan report and the fixes made for serious findings.', 90),
        plain_statement: 'Systems were scanned this quarter and serious findings fixed.',
      },
    ],
  },
  {
    control_key: 'threat.intelligence',
    title: 'We keep up with new threats',
    plain_summary: 'Someone follows news about new attacks that could affect the business and passes on what matters.',
    category: 'operations',
    risk_weight: 2,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Threat news statement', 'Describe where you get security news and who reads it.', 365),
        plain_statement: 'Someone follows security news and shares what matters.',
      },
    ],
  },
  {
    control_key: 'incident.response',
    title: 'Security incidents are handled by a plan',
    plain_summary:
      'Anyone can report a security event, and a written plan says how incidents are assessed, handled, learned from and documented.',
    category: 'incident',
    risk_weight: 4,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Incident response plan', 'The written plan for handling security incidents.', 365),
        plain_statement: 'An incident response plan is written down and current.',
      },
    ],
  },
  {
    control_key: 'bcp.continuity',
    title: 'The business can keep running after a disruption',
    plain_summary: 'There is a plan, with spare capacity where it matters, for keeping the business going when something breaks.',
    category: 'continuity',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Business continuity plan', 'The plan for keeping the business running after a disruption.', 365),
        plain_statement: 'A business continuity plan is written down and current.',
      },
    ],
  },

  /* ── Suppliers ───────────────────────────────────────────────────────── */
  {
    control_key: 'vendors.management',
    title: 'Key suppliers are reviewed and under contract',
    plain_summary:
      'Suppliers that handle your information, including cloud services, are reviewed, have security terms in their contract and are monitored.',
    category: 'suppliers',
    risk_weight: 4,
    suggested_assertions: [
      {
        probe_key: 'vendors.critical_have_award',
        plain_statement: 'Every critical supplier has an active award on file.',
      },
    ],
    suggested_manual_evidence: [
      {
        spec: file('Supplier security review', 'The latest security review of your important suppliers.', 365),
        plain_statement: 'Important suppliers were reviewed for security in the last year.',
      },
    ],
  },

  /* ── Assets and data ─────────────────────────────────────────────────── */
  {
    control_key: 'assets.inventory',
    title: 'There is a list of systems and devices',
    plain_summary:
      'Systems, devices and the information they hold are listed with an owner, used acceptably, and returned when people leave.',
    category: 'assets',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Asset inventory', 'The current list of systems and devices, each with an owner.', 180),
        plain_statement: 'A current list of systems and devices has an owner for each.',
      },
    ],
  },
  {
    control_key: 'assets.device_encryption',
    title: 'Laptops are encrypted',
    plain_summary: 'Every company laptop has its disk encrypted, including when it travels outside the office.',
    category: 'assets',
    risk_weight: 5,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file(
          'Laptop encryption report',
          'A report from your device management tool showing disk encryption on every laptop.',
          90,
        ),
        plain_statement: 'Every company laptop has disk encryption switched on.',
      },
    ],
  },
  {
    control_key: 'assets.endpoint_protection',
    title: 'Computers are protected against malware',
    plain_summary: 'Computers run protection against harmful software and it stays up to date.',
    category: 'assets',
    risk_weight: 4,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Malware protection report', 'A report showing protection is installed and current on every computer.', 90),
        plain_statement: 'Malware protection is installed and current on every computer.',
      },
    ],
  },
  {
    control_key: 'assets.media_disposal',
    title: 'Old devices and storage are wiped before disposal',
    plain_summary: 'Drives, devices and data that are no longer needed are wiped or destroyed safely.',
    category: 'assets',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Disposal statement', 'Describe how old devices and storage are wiped or destroyed.', 365),
        plain_statement: 'Old devices and storage are wiped or destroyed before disposal.',
      },
    ],
  },
  {
    control_key: 'data.classification',
    title: 'Information is labelled by how sensitive it is',
    plain_summary:
      'Information is sorted by how sensitive it is, labelled, and the most sensitive is masked or kept from leaking.',
    category: 'data',
    risk_weight: 3,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Data classification guide', 'The guide that says how information is classified and handled.', 365),
        plain_statement: 'Information is classified and handled by a written guide.',
      },
    ],
  },
  {
    control_key: 'data.encryption',
    title: 'Data is encrypted when stored and when sent',
    plain_summary: 'Sensitive data is encrypted where it is stored and while it travels between systems.',
    category: 'data',
    risk_weight: 4,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Encryption settings', 'Screenshots or a report showing encryption for stored data and connections.', 365),
        plain_statement: 'Sensitive data is encrypted at rest and in transit.',
      },
    ],
  },
  {
    control_key: 'data.privacy',
    title: 'Personal data is handled lawfully',
    plain_summary: 'Personal information about customers and staff is collected, kept and shared only as the law allows.',
    category: 'data',
    risk_weight: 4,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Privacy notice and data map', 'Your privacy notice and the list of where personal data is kept.', 365),
        plain_statement: 'A privacy notice and a personal data map are current.',
      },
    ],
  },
  {
    control_key: 'network.security',
    title: 'Networks are protected and separated',
    plain_summary: 'Networks are protected at the edge, split so a problem in one place cannot spread, and risky websites are blocked.',
    category: 'network',
    risk_weight: 4,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: file('Network protection settings', 'Firewall or cloud network settings showing protection and separation.', 180),
        plain_statement: 'Network protection and separation settings were reviewed this half-year.',
      },
    ],
  },
  {
    control_key: 'communication.external',
    title: 'Outsiders can reach us about security',
    plain_summary:
      'Customers, partners and authorities know how to report a security issue to us, and we keep contact with the right outside groups.',
    category: 'communication',
    risk_weight: 2,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Security contact statement', 'Describe how outsiders report security issues and who answers.', 365),
        plain_statement: 'Outsiders have a published way to report security issues.',
      },
    ],
  },

  /* ── Physical ────────────────────────────────────────────────────────── */
  {
    control_key: 'physical.premises',
    title: 'Offices and equipment rooms are secured',
    plain_summary:
      'Buildings, rooms and equipment that hold information are locked, watched, protected from fire and flood, and maintained.',
    category: 'physical',
    risk_weight: 2,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Premises security statement', 'Describe how your premises and equipment rooms are secured.', 365),
        plain_statement: 'Premises and equipment rooms are physically secured.',
      },
    ],
  },
  {
    control_key: 'physical.workspace',
    title: 'Desks and screens are kept clear',
    plain_summary: 'Papers are put away and screens are locked when people step away.',
    category: 'physical',
    risk_weight: 1,
    suggested_assertions: [],
    suggested_manual_evidence: [
      {
        spec: statement('Clear desk statement', 'Describe your clear desk and screen lock rules.', 365),
        plain_statement: 'Clear desk and screen lock rules are written down and shared.',
      },
    ],
  },
];

const BY_KEY = new Map(LIBRARY_CONTROLS.map((c) => [c.control_key, c]));

export function libraryControl(key: string): LibraryControl | undefined {
  return BY_KEY.get(key);
}
