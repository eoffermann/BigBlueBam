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

  // M6 rows (spec 10.2) and stories 4-6 (spec 11.4).
  m6: {
    // Gilligan replaces API keys yearly; both key checks are revised to this many days.
    keyPolicyDays: 365,
    // Story 6: the Radio Relay key is the one failing item on the key control; the Professor
    // proposes accepting it, Skipper approves it in Bastion, so the control reads
    // "Not met, risk accepted" and counts under Not met with one risk accepted.
    radioRelay: {
      keyName: 'Radio Relay',
      ageDays: 400,
      controlKey: 'keys.rotation',
      controlTitle: 'API keys are replaced and unused ones removed',
      proposerEmail: 'professor@gilligantravel.example',
      proposerRole: 'professor',
      approverEmail: 'skipper@gilligantravel.example',
      ownerName: 'The Professor',
      reason: 'The Radio Relay bridge only accepts a key typed in at the mast, so it is changed by hand at every radio service.',
      compensatingNote: 'The key only works from the island network, and the Professor checks it at every service.',
      expiresInDays: 120,
      stateWords: 'Not met, risk accepted',
    },
    riskAccepted: 1,
    // Story 4: nothing uploaded for laptop encryption, so it is the top gap; drafting its fix files
    // an evidence request the Review queue decides.
    laptop: {
      controlKey: 'assets.device_encryption',
      title: 'Laptops are encrypted',
      ownerEmail: 'professor@gilligantravel.example',
      gapKind: 'manual_missing',
      fixTemplate: 'evidence_request',
    },
    // The seeded evidence request: the 2-Step report expires in 12 days (manual_expiring).
    evidenceRequest: { controlKey: 'auth.mfa', gapKind: 'manual_expiring' },
    // The Professor owns the technical controls the stories use.
    professorOwns: ['assets.device_encryption', 'keys.rotation', 'auth.mfa', 'change.peer_review'],
    // Skipper's risk calibration: these weigh less than laptops for a firm whose crew carries
    // laptops between islands.
    riskWeights: { 'vuln.management': 4, 'access.offboarding': 4, 'change.peer_review': 4 },
    // Story 5: the code-review control cites PR #42, names the repository on the list that is not
    // connected, carries the ping note, and Coral Reef Booking is a population gap.
    codeReview: {
      controlKey: 'change.peer_review',
      owner: 'gilligan-travel',
      prRepo: 'rescue-radio-firmware',
      prNumber: 42,
      prTitle: 'Bump the radio firmware to 2.1',
      integrations: [
        { repo: 'rescue-radio-firmware', project: 'Fix the Radio' },
        { repo: 'coral-reef-booking', project: 'Island Infrastructure' },
      ],
      listedNotConnected: 'gilligan-travel/lagoon-booking-site',
      unlisted: 'gilligan-travel/coral-reef-booking',
      pingNote: 'Redeliver on the ping',
      populationGapWords: 'Something new is not on the list',
    },
  },

  // M7 rows (spec 10.2): the security policy in Gilligan's Beacon, read by 5 of the 7 castaways.
  // Gilligan and Ginger have not read it yet (story 12 at M10: Gilligan attests, coverage rises).
  m7: {
    policy: {
      slug: 'island-information-security-policy',
      title: 'Island Information Security Policy',
      cadenceDays: 365,
      audienceEmails: [
        'skipper@gilligantravel.example',
        'professor@gilligantravel.example',
        'gilligan@gilligantravel.example',
        'maryann@gilligantravel.example',
        'ginger@gilligantravel.example',
        'howell@gilligantravel.example',
        'lovey@gilligantravel.example',
      ],
      attestedEmails: [
        'skipper@gilligantravel.example',
        'professor@gilligantravel.example',
        'maryann@gilligantravel.example',
        'howell@gilligantravel.example',
        'lovey@gilligantravel.example',
      ],
      required: 7,
      attested: 5,
      label: '5 of 7 have read the current version',
    },
  },

  // M8 rows (spec 10.2): Howell Industries' vendor security review (an xlsx in Bin, 24 questions),
  // autofilled. Story 7: the laptop-encryption row is "Needs an expert" ("We cannot currently prove
  // this", nothing proves laptops are encrypted), the Radio Relay row is "Check this" and names the
  // accepted exception, and Approve stays disabled until the "Needs an expert" rows are reviewed.
  m8: {
    questionnaire: {
      title: 'Howell Industries Vendor Security Review',
      requester: 'Howell Industries',
      fileName: 'howell-vendor-security-review.xlsx',
      sheet: 'Security Review',
      rows: 24,
      encryption: {
        question: 'Are all company laptops encrypted at rest?',
        band: 'low',
        words: 'Needs an expert',
        answerStartsWith: 'We cannot currently prove this.',
      },
      radioRelay: {
        question: 'Do you replace API keys and service credentials at least once a year?',
        band: 'medium',
        words: 'Check this',
        mentions: 'Accepted exception',
      },
    },
  },

  // M9 rows (spec 10.2): the auditor room for Lagoon & Reef CPAs on ISO 27001 with two
  // access-log rows (the auditor opened the room and looked at one control), and one ISO packet
  // with the Statement of Applicability. Stories 8-10 create and revoke their own rooms.
  m9: {
    room: {
      label: 'Lagoon & Reef CPAs, Type I readiness',
      framework: 'iso27001',
      expiresInDays: 30,
      periodDays: 90,
      accessLogRows: 2,
    },
    packet: {
      framework: 'iso27001',
      periodDays: 90,
      files: ['manifest.json', 'controls.csv', 'statement_of_applicability.csv', 'summary.pdf'],
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
