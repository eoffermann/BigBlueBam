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

interface BastionSeedExpectations {
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
  companyProfile: Record<string, string | boolean>;
}

declare module '*bastion.expectations.mjs' {
  export const BASTION_SEED_EXPECTATIONS: BastionSeedExpectations;
}
