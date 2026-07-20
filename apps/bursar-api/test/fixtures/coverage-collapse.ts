// Deterministic coverage-collapse fixtures (spec 4.6, 20.2). These four are buildable WITHOUT
// procurement-expert hand-labeling (unlike the 40-tuple false-absence corpus, which is the one
// genuinely human-blocked item recorded in the HUMAN_SETUP doc). Each fixture is the confirmed
// tree + the offer's parsed lines + the RECORDED classifier answers, so a CI test can replay them
// through `adjudicateOffer` and assert the §4 defenses and the §4.7 diff invariant deterministically.

import type {
  AdjudicationAnswer,
  AdjudicationLine,
  AdjudicationNode,
  AdjudicationOffer,
  AdjudicationSettings,
} from '../../src/services/engines/coverage-adjudication.js';

export const SETTINGS: AdjudicationSettings = {
  node_term_overlap_floor: 0.25,
  blanket_cumulative_cap: 4,
  evidence_concentration_floor: 0.5,
  blanket_fanout_cap: 4,
};

export function offer(overrides: Partial<AdjudicationOffer> = {}): AdjudicationOffer {
  return {
    offer_id: 'offer-1',
    parse_quality: 0.9,
    parse_quality_floor: 0.35,
    blanket_suspected: false,
    injection_suspected: false,
    ...overrides,
  };
}

function node(id: string, title: string, strength: AdjudicationNode['normative_strength'] = 'mandatory'): AdjudicationNode {
  return { scope_node_id: id, parent_id: null, title, description: null, normative_strength: strength };
}

function line(id: string, raw_text: string, opts: Partial<AdjudicationLine> = {}): AdjudicationLine {
  return {
    offer_line_id: id,
    raw_text,
    line_role: 'base',
    blanket_claim: false,
    exclusion_hit: false,
    extended_minor: null,
    ...opts,
  };
}

function covered(nodeId: string, lineId: string, quote: string, extra: Partial<AdjudicationAnswer> = {}): AdjudicationAnswer {
  return {
    scope_node_id: nodeId,
    verdict: 'covered',
    cited_offer_line_id: lineId,
    quote,
    classifier_confidence: 0.95,
    rejected_candidates: [],
    ...extra,
  };
}

// Fourteen two-token requirement titles so a legitimate multi-item line clears the 0.25 Jaccard
// floor (predicate 3) while a single node's overlap against a huge blanket line does not.
const TITLES: Array<[string, string]> = [
  ['n0', 'Site installation'],
  ['n1', 'Crew training'],
  ['n2', 'Parts warranty'],
  ['n3', 'Escalation cap'],
  ['n4', 'Spare parts'],
  ['n5', 'System commissioning'],
  ['n6', 'Data export'],
  ['n7', 'Acceptance testing'],
  ['n8', 'Technical documentation'],
  ['n9', 'Support services'],
  ['n10', 'Training materials'],
  ['n11', 'Site survey'],
  ['n12', 'Project management'],
  ['n13', 'System handover'],
];

export function tree(count = 14): AdjudicationNode[] {
  return TITLES.slice(0, count).map(([id, title]) => node(id, title));
}

/* ---------------- single-blanket: one all-inclusive line over the 14-node tree ------------ */
export function singleBlanket() {
  const nodes = tree(14);
  const blanketText =
    'Site installation, crew training, parts warranty, escalation cap, spare parts, system ' +
    'commissioning, data export, acceptance testing, technical documentation, support services, ' +
    'training materials, site survey, project management and system handover are fully included in ' +
    'this all-inclusive turnkey price.';
  const lines = [line('L0', blanketText, { blanket_claim: true })];
  const answers = new Map<string, AdjudicationAnswer>();
  for (const [id, title] of TITLES) answers.set(id, covered(id, 'L0', title));
  return { nodes, lines, answers, offer: offer() };
}

/* ---------------- split-blanket: 4 lines x 3 nodes, NO lexicon token ---------------------- */
export function splitBlanket() {
  const nodes = tree(12);
  const lines = [
    line('L0', 'Site installation, crew training and parts warranty are provided'),
    line('L1', 'Escalation cap, spare parts and system commissioning are provided'),
    line('L2', 'Data export, acceptance testing and technical documentation are provided'),
    line('L3', 'Support services, training materials and site survey are provided'),
  ];
  const map: Record<string, string> = {
    n0: 'L0', n1: 'L0', n2: 'L0', n3: 'L1', n4: 'L1', n5: 'L1',
    n6: 'L2', n7: 'L2', n8: 'L2', n9: 'L3', n10: 'L3', n11: 'L3',
  };
  const answers = new Map<string, AdjudicationAnswer>();
  for (const n of nodes) {
    const t = TITLES.find(([id]) => id === n.scope_node_id)![1];
    answers.set(n.scope_node_id, covered(n.scope_node_id, map[n.scope_node_id]!, t));
  }
  return { nodes, lines, answers, offer: offer() };
}

/* ---------------- legitimate-subprice: itemized priced lines, one per node ----------------- */
export function legitimateSubprice() {
  const nodes = tree(6);
  const prices = [320000, 240000, 180000, 90000, 60000, 150000];
  const lines = TITLES.slice(0, 6).map(([id, title], i) =>
    line(`L${i}`, `${title} $${(prices[i]! / 100).toLocaleString()}`, { extended_minor: prices[i]! }),
  );
  const answers = new Map<string, AdjudicationAnswer>();
  TITLES.slice(0, 6).forEach(([id, title], i) => {
    answers.set(id, covered(id, `L${i}`, title, { allocation_method: 'explicit_subprice', priced_amount_minor: prices[i]! }));
  });
  return { nodes, lines, answers, offer: offer() };
}

/* ---------------- injection: good evidence but the offer is injection_suspected ------------ */
export function injectionSuspected() {
  const base = legitimateSubprice();
  return { ...base, offer: offer({ injection_suspected: true }) };
}
