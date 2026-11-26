/**
 * BASTION_SEED_EXPECTATIONS - the ONE source for the numbers the Bastion gilligan seed
 * produces and the Playwright suite asserts (spec 10.3). scripts/seed-gilligan/bastion.mjs
 * and apps/e2e/src/apps/bastion/tests/*.spec.ts both read it.
 *
 * This file is plain .mjs and cannot import the TypeScript library, so the values are
 * literals. Each one is re-derived from apps/bastion-api/src/library by
 * apps/bastion-api/test/seed-expectations.test.ts, so a library change that moves a number
 * fails that test here rather than surfacing as a confusing Playwright failure.
 *
 * Derivations (M3; later milestones extend this object):
 *   - SOC 2 view: templateControlKeys(SOC2) = 46 controls, none excluded. The seed confirms
 *     every proposed check except those on the four `leftUnconfirmed` controls, so
 *     setUp = 46 - 4 = 42 and notSetUp = 4.
 *   - ISO 27001 view: templateControlKeys(ISO27001) = 47 controls. The ten premises
 *     requirements below are marked not applicable; they are the only ISO links of
 *     physical.premises, so that one control leaves the ISO denominator (notApplicable 1,
 *     controlsInView 46). The four unconfirmed controls are linked in both frameworks, so
 *     notSetUp is 4 here too and setUp = 46 - 4 = 42.
 *   - sharedControlCount: crosswalk() length, the controls ISO reuses from SOC 2 (45).
 *   - soaRowCount: the 93 Annex A requirements of ISO 27001:2022.
 *   - m5.provenByEvidence: auth.mfa (one manual file check) and hr.screening (one statement
 *     check) are the only checks with accepted evidence, both have no other check, and both are
 *     linked in SOC 2 (CC6.1, CC1.4) and ISO 27001 (A.5.17, A.6.1), so 2 in either view.
 */

export const BASTION_SEED_EXPECTATIONS = {
  org: { slug: 'gilligan-travel-ltd' },

  // Skipper owns the program (org owner); every Bastion call in the seed is made as Skipper.
  actorEmail: 'skipper@gilligantravel.example',

  // Adopted in this order (spec 10.2: SOC 2 then ISO 27001).
  frameworks: [
    { templateKey: 'soc2', name: 'SOC 2', controlsInView: 46, setUp: 42, notSetUp: 4, notApplicable: 0 },
    { templateKey: 'iso27001', name: 'ISO 27001', controlsInView: 46, setUp: 42, notSetUp: 4, notApplicable: 1 },
  ],

  sharedControlCount: 45,
  // 46 SOC 2 + 47 ISO - 45 shared.
  totalControlCount: 48,

  // Left with proposed (unconfirmed) checks so "Not set up yet: 4" shows (spec 10.2).
  leftUnconfirmed: ['threat.intelligence', 'projects.security', 'communication.external', 'hr.disciplinary'],

  // The MFA control shows "CC6.1" and "A.5.17" (spec 10.2).
  mfa: { controlKey: 'auth.mfa', title: 'Two-step sign-in is required', refs: ['CC6.1', 'A.5.17'] },

  complianceProject: { name: 'Compliance', taskIdPrefix: 'COMP' },

  // GitHub population confirmed as "This is the complete list" on both change controls.
  githubPopulation: {
    controlKeys: ['change.peer_review', 'change.traceability'],
    probeKeys: ['change.merge_reviewed', 'change.merge_traceable'],
    repos: ['gilligan-travel/rescue-radio-firmware', 'gilligan-travel/lagoon-booking-site'],
  },

  iso: {
    soaRowCount: 93,
    notApplicableControlKey: 'physical.premises',
    notApplicableReason: 'We operate from a shared island hut with no server room',
    notApplicableRefs: ['A.7.1', 'A.7.2', 'A.7.3', 'A.7.4', 'A.7.5', 'A.7.6', 'A.7.8', 'A.7.11', 'A.7.12', 'A.7.13'],
  },

  // M5 rows (spec 10.2). Uploaded and self-attested evidence, the empty laptop-encryption check,
  // and the "Crew roster export" feed with a key.
  m5: {
    // The Professor uploads the Google Workspace 2-Step Verification report; Skipper accepts it.
    // It is valid through the end of the day 12 days after seeding (org time zone), so the
    // Readiness page and the Evidence locker show "expires in 12 days" on the seed day.
    twoStep: {
      controlKey: 'auth.mfa',
      title: 'Google Workspace 2-Step Verification report',
      sourceSystem: 'Google Workspace',
      uploaderEmail: 'professor@gilligantravel.example',
      uploaderRole: 'professor',
      reviewerEmail: 'skipper@gilligantravel.example',
      fileName: '2-step-verification-report.pdf',
      daysLeft: 12,
      producedDaysAgo: 2,
    },
    // Mary Ann's written statement about background checks: self-attested, accepted by Skipper.
    backgroundChecks: {
      controlKey: 'hr.screening',
      title: 'Background checks for everyone who joined this year',
      sourceSystem: 'Crew records kept by Mary Ann',
      authorEmail: 'maryann@gilligantravel.example',
      statement:
        'Everyone who joined Gilligan Travel Ltd this year had a background check before their first charter: the Professor and Ginger Grant. Checked by Mary Ann Summers against the crew records.',
      validDays: 300,
    },
    // Nothing is uploaded for laptop encryption, so it stays "Can't prove yet" (the top gap at M6).
    laptopEncryption: { controlKey: 'assets.device_encryption' },
    // Both evidence-backed controls count under "Proven by evidence you provided" in both views.
    provenByEvidence: 2,
    feed: {
      feedKey: 'crew-roster',
      label: 'Crew roster export',
      feedKind: 'roster',
      cadenceDays: 7,
      keyLabel: 'Roster export job',
      // One record per castaway, keyed so a re-seed is a no-op.
      records: ['skipper', 'gilligan', 'professor', 'maryann', 'ginger', 'howell', 'lovey'],
    },
  },

  companyProfile: {
    company_size: '1-10',
    work_style: 'office',
    has_own_premises: false,
    builds_software: true,
    uses_github: true,
    stores_customer_personal_data: true,
    takes_card_payments: true,
    uses_cloud_hosting: true,
    has_contractors: false,
    issues_company_laptops: true,
  },
};
