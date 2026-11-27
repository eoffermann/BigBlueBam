// Ambient declaration so the Bastion Playwright suite can import the canonical number set
// from scripts/seed-gilligan/bastion.expectations.mjs (spec 10.3) and typecheck under
// apps/e2e's tsconfig (rootDir: src) WITHOUT pulling the .mjs into the program. The wildcard
// suffix pattern matches the relative import in the specs; the shape mirrors
// bastion.expectations.mjs exactly (M3 rows; later milestones extend both together).

interface BastionFrameworkExpectation {
  templateKey: 'soc2' | 'iso27001';
  name: string;
  controlsInView: number;
  setUp: number;
  notSetUp: number;
  notApplicable: number;
}

interface BastionPolicyExpectation {
  slug: string;
  title: string;
  cadenceDays: number;
  audienceEmails: string[];
  attestedEmails: string[];
  required: number;
  attested: number;
  label: string;
  /** #387: the control the policy proves, its two pinned checks, and how it then reads. */
  controlKey: string;
  probes: string[];
  stateWords: string;
  gapKind: string;
}

interface BastionSeedExpectations {
  m7: { policy: BastionPolicyExpectation };
  m8: {
    questionnaire: {
      title: string;
      requester: string;
      fileName: string;
      sheet: string;
      rows: number;
      /** #271: the seed drafts without the AI, so the story rows are deterministic. */
      useAi: boolean;
      encryption: { question: string; band: 'low' | 'medium' | 'high'; words: string; answerStartsWith: string; controlKey: string; libraryAnswer: string; reasons: string[] };
      radioRelay: { question: string; band: 'low' | 'medium' | 'high'; words: string; mentions: string; controlKey: string; libraryAnswer: string; reasons: string[] };
    };
  };
  org: { slug: string };
  actorEmail: string;
  frameworks: BastionFrameworkExpectation[];
  sharedControlCount: number;
  totalControlCount: number;
  leftUnconfirmed: string[];
  mfa: { controlKey: string; title: string; refs: string[] };
  complianceProject: { name: string; taskIdPrefix: string };
  githubPopulation: { controlKeys: string[]; probeKeys: string[]; repos: string[] };
  iso: {
    soaRowCount: number;
    notApplicableControlKey: string;
    notApplicableReason: string;
    notApplicableRefs: string[];
  };
  m5: {
    twoStep: {
      controlKey: string;
      title: string;
      sourceSystem: string;
      uploaderEmail: string;
      uploaderRole: string;
      reviewerEmail: string;
      fileName: string;
      daysLeft: number;
      producedDaysAgo: number;
    };
    backgroundChecks: { controlKey: string; title: string; sourceSystem: string; authorEmail: string; statement: string; validDays: number };
    laptopEncryption: { controlKey: string };
    provenByEvidence: number;
    feed: { feedKey: string; label: string; feedKind: string; cadenceDays: number; keyLabel: string; records: string[] };
  };
  m6: {
    keyPolicyDays: number;
    radioRelay: {
      keyName: string;
      ageDays: number;
      controlKey: string;
      controlTitle: string;
      proposerEmail: string;
      proposerRole: string;
      approverEmail: string;
      ownerName: string;
      reason: string;
      compensatingNote: string;
      expiresInDays: number;
      stateWords: string;
    };
    riskAccepted: number;
    laptop: { controlKey: string; title: string; ownerEmail: string; gapKind: string; fixTemplate: string };
    evidenceRequest: { controlKey: string; gapKind: string };
    professorOwns: string[];
    riskWeights: Record<string, number>;
    codeReview: {
      controlKey: string;
      owner: string;
      prRepo: string;
      prNumber: number;
      prTitle: string;
      integrations: Array<{ repo: string; project: string }>;
      listedNotConnected: string;
      unlisted: string;
      pingNote: string;
      populationGapWords: string;
    };
  };
  companyProfile: Record<string, string | boolean>;
}

declare module '*bastion.expectations.mjs' {
  export const BASTION_SEED_EXPECTATIONS: BastionSeedExpectations;
}
