// Ambient declaration so the Bursar Playwright suite can import the canonical
// number set from scripts/seed-gilligan/bursar.expectations.mjs (spec 19.3) and
// typecheck under apps/e2e's tsconfig (rootDir: src) WITHOUT pulling the .mjs
// into the program. The wildcard suffix pattern matches the relative import in
// bursar.spec.ts; the shape mirrors bursar.expectations.mjs exactly.

interface BursarOfferExpectation {
  key: string;
  label: string;
  vendor: string;
  sourceFormat: string;
  statedMinor: number;
  gapAdjustedMinor: number | null;
  renderable: boolean;
  gapCount?: number;
  unpricedGapCount?: number;
  blanket?: boolean;
  autoPublishedCovered?: number;
  finding?: string;
  mandatoryNeedsReview?: number;
  withheldReason?: string;
  gaps?: Array<{
    node: string;
    verdict: string;
    deltaKind?: string;
    valuedMinor?: number | null;
    rung?: number | null;
  }>;
}

interface BursarSeedExpectations {
  org: { slug: string; name: string };
  request: {
    title: string;
    ownerEmail: string;
    currency: string;
    category: string;
    budgetMinor: number;
    nodeCount: number;
    mandatoryTitles: string[];
    shouldHaveTitles: string[];
  };
  vendors: string[];
  offers: BursarOfferExpectation[];
  award: {
    vendor: string;
    baseline: {
      included: number;
      excludedAtAward: number;
      absentAtAward: number;
      warrantyNode: { title: string; kind: string; deltaKind: string };
    };
  };
  punchline: { gapAdjustedHowellMinor: number; gapAdjustedRadioMinor: number };
  detectors: {
    priceDrift: { vendor: string; pctAboveBaseline: number; detector: string };
    scopeDivergence: { label: string; detector: string };
    unbaselinedVendor: { vendor: string; recurringCharges: number; detector: string };
    renewalCliff: { vendor: string; leadBand: string; detector: string };
    orphanedCustody: { present: boolean };
  };
}

declare module '*bursar.expectations.mjs' {
  export const BURSAR_SEED_EXPECTATIONS: BursarSeedExpectations;
  const _default: BursarSeedExpectations;
  export default _default;
}
