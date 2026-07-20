/**
 * BURSAR_SEED_EXPECTATIONS - the ONE source of truth for the numbers the Bursar
 * gilligan seed produces and the Playwright suite asserts (spec 19.3). This is the
 * third round a seed-number mismatch surfaced; a seed change that breaks an
 * assertion breaks it here, at the one place both `scripts/seed-gilligan/bursar.mjs`
 * and `apps/e2e/src/apps/bursar/tests/bursar.spec.ts` read.
 *
 * Money is in MINOR units (cents), matching bursar-api's `amount_minor` columns and
 * `bursarSpendRowSchema`. Dollar callouts in comments are the human-readable form.
 *
 * Every figure below is computable from spec 10.1 as written (see spec 19.1's
 * "one source for the numbers" note):
 *   - Howell training rung 2 = mean(Radio 2400, Lagoon 2600) = 2500;
 *     Howell installation rung 2 = mean(Radio 3200, Lagoon 2900) = 3050;
 *     gap_adjusted(Howell) = 16400 + 2500 + 3050 = 21950.
 *   - Radio warranty rung 1 (own optional "24-month warranty upgrade +600" line);
 *     gap_adjusted(Radio) = 19100 + 600 = 19700.
 *   - Lagoon warranty rung 2 = mean(Howell 1100, Radio 1300) = 1200; escalation
 *     cap unvalued; gap_adjusted(Lagoon) = 17800 + 1200 = 19000 (+1 gap unpriced).
 *   - Professor's Lab Supply: split-blanket, totals withheld (not computed).
 */

export const BURSAR_SEED_EXPECTATIONS = {
  org: { slug: 'gilligan-travel-ltd', name: "Gilligan's Travel, Ltd." },

  // Skipper owns the request (org owner in the gilligan cast).
  request: {
    title: 'Lagoon Rescue Beacon Procurement',
    ownerEmail: 'skipper@gilligantravel.example',
    currency: 'USD',
    category: 'hardware_purchase',
    budgetMinor: 1_800_000, // $18,000
    // Total scope-tree nodes after derivation + human adds + library apply.
    nodeCount: 14,
    mandatoryTitles: [
      'On-island installation and commissioning',
      'Crew training for six',
      '24-month parts warranty',
    ],
    // Library-derived should_have nodes.
    shouldHaveTitles: ['Data export on termination', 'Price escalation cap'],
  },

  vendors: [
    'Howell Industries Salvage',
    'Radio Parts & Coconut Wire Co',
    'Lagoon Freight Lines',
    'Island Weather Feed',
    "Professor's Lab Supply",
  ],

  // The four offers (spec 19.1). `statedMinor` is the sticker total; `gapAdjustedMinor`
  // is the comparable total after valuing gaps (null when withheld / not renderable).
  offers: [
    {
      key: 'howell',
      label: 'Howell Industries Salvage',
      vendor: 'Howell Industries Salvage',
      sourceFormat: 'pdf',
      statedMinor: 1_640_000, // $16,400
      gapAdjustedMinor: 2_195_000, // $21,950
      renderable: true,
      gapCount: 2,
      gaps: [
        { node: 'Crew training for six', verdict: 'absent', valuedMinor: 250_000, rung: 2 },
        { node: 'On-island installation and commissioning', verdict: 'excluded_explicit', valuedMinor: 305_000, rung: 2 },
      ],
    },
    {
      key: 'radio',
      label: 'Radio Parts & Coconut Wire Co',
      vendor: 'Radio Parts & Coconut Wire Co',
      sourceFormat: 'csv', // exported spreadsheet
      statedMinor: 1_910_000, // $19,100
      gapAdjustedMinor: 1_970_000, // $19,700
      renderable: true,
      gapCount: 1,
      gaps: [
        { node: '24-month parts warranty', verdict: 'partial', deltaKind: 'term', valuedMinor: 60_000, rung: 1 },
      ],
    },
    {
      key: 'lagoon',
      label: 'Lagoon Freight Lines',
      vendor: 'Lagoon Freight Lines',
      sourceFormat: 'email',
      statedMinor: 1_780_000, // $17,800
      gapAdjustedMinor: 1_900_000, // $19,000
      renderable: true,
      gapCount: 1, // one priced gap...
      unpricedGapCount: 1, // ...plus the unvalued escalation-cap should_have supplement
      gaps: [
        { node: '24-month parts warranty', verdict: 'absent', valuedMinor: 120_000, rung: 2 },
        { node: 'Price escalation cap', verdict: 'absent', valuedMinor: null, rung: null },
      ],
    },
    {
      key: 'professor',
      label: "Professor's Lab Supply",
      vendor: "Professor's Lab Supply",
      sourceFormat: 'pdf',
      statedMinor: 1_590_000, // $15,900
      gapAdjustedMinor: null, // withheld: split-blanket, not computed
      renderable: false,
      blanket: true,
      autoPublishedCovered: 0,
      finding: 'offer_manipulation_suspected',
      // The §4.7 negative: the diff renders ALL mandatory nodes as needs_review.
      mandatoryNeedsReview: 3, // the three named mandatory nodes (subset asserted)
      withheldReason: 'blanket_cap',
    },
  ],

  // The award goes to Radio Parts - NOT the lowest gap_adjusted - because Lagoon's
  // absent warranty is disqualifying on a rescue beacon (spec 19.1). Bursar informs
  // the decision; it does not make it.
  award: {
    vendor: 'Radio Parts & Coconut Wire Co',
    baseline: {
      included: 14,
      excludedAtAward: 0,
      absentAtAward: 0,
      // The warranty node is `included` but carries a term delta.
      warrantyNode: { title: '24-month parts warranty', kind: 'included', deltaKind: 'term' },
    },
  },

  // The punchline (spec 20.3 step 7): the sticker-cheaper Howell bid is the pricier
  // deal once its silence is valued.
  punchline: {
    gapAdjustedHowellMinor: 2_195_000,
    gapAdjustedRadioMinor: 1_970_000,
    // gapAdjustedHowell > gapAdjustedRadio
  },

  // Post-award, one live finding per detector (spec 19.3).
  detectors: {
    priceDrift: { vendor: 'Island Weather Feed', pctAboveBaseline: 40, detector: 'price_drift' },
    scopeDivergence: { label: 'expedited lagoon delivery', detector: 'scope_divergence' },
    unbaselinedVendor: { vendor: "Professor's Lab Supply", recurringCharges: 4, detector: 'unbaselined_vendor' },
    renewalCliff: { vendor: 'Island Weather Feed', leadBand: 't_minus_60', detector: 'renewal_cliff' },
    orphanedCustody: { present: true },
  },
};

export default BURSAR_SEED_EXPECTATIONS;
