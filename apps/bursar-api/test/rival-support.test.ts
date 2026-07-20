import { describe, it, expect } from 'vitest';
import {
  tallyDistinctSupporters,
  canAutoPromoteRival,
  type RivalSupporter,
} from '../src/lib/rival-support.js';

// Defense 4 (spec 4.5): a rival node may only be promoted when >= 2 DISTINCT real-world
// identities back it - braid_profile_id, else bond_company_id, NEVER vendor_id (one vendor under
// two rows must not satisfy ">= 2"). Injection/blanket-suspected offers contribute nothing.

const S = (o: Partial<RivalSupporter> & { offer_id: string }): RivalSupporter => ({
  braid_profile_id: null,
  bond_company_id: null,
  injection_suspected: false,
  blanket_suspected: false,
  ...o,
});

describe('tallyDistinctSupporters', () => {
  it('counts two distinct braid profiles as promotable', () => {
    const t = tallyDistinctSupporters([
      S({ offer_id: 'o1', braid_profile_id: 'p1' }),
      S({ offer_id: 'o2', braid_profile_id: 'p2' }),
    ]);
    expect(t.distinct).toBe(2);
    expect(canAutoPromoteRival(t)).toBe(true);
  });

  it('collapses two offers from ONE company to a single distinct supporter (the collusion attack)', () => {
    const t = tallyDistinctSupporters([
      S({ offer_id: 'o1', bond_company_id: 'c1' }),
      S({ offer_id: 'o2', bond_company_id: 'c1' }),
    ]);
    expect(t.distinct).toBe(1);
    expect(canAutoPromoteRival(t)).toBe(false);
  });

  it('does NOT count distinct offer_ids as distinct supporters (uniqueness is not on vendor_id)', () => {
    // No identity resolved at all: both are undecided, distinct stays 0.
    const t = tallyDistinctSupporters([S({ offer_id: 'o1' }), S({ offer_id: 'o2' })]);
    expect(t.distinct).toBe(0);
    expect(t.undecided).toBe(2);
    expect(canAutoPromoteRival(t)).toBe(false);
  });

  it('excludes injection- and blanket-suspected offers from the tally', () => {
    const t = tallyDistinctSupporters([
      S({ offer_id: 'o1', braid_profile_id: 'p1' }),
      S({ offer_id: 'o2', braid_profile_id: 'p2', injection_suspected: true }),
      S({ offer_id: 'o3', braid_profile_id: 'p3', blanket_suspected: true }),
    ]);
    expect(t.distinct).toBe(1);
    expect(t.excluded).toBe(2);
    expect(canAutoPromoteRival(t)).toBe(false);
  });

  it('prefers braid_profile_id over bond_company_id for identity', () => {
    const t = tallyDistinctSupporters([
      S({ offer_id: 'o1', braid_profile_id: 'p1', bond_company_id: 'c1' }),
      S({ offer_id: 'o2', braid_profile_id: 'p1', bond_company_id: 'c2' }),
    ]);
    // Same profile despite different companies -> one distinct supporter.
    expect(t.distinct).toBe(1);
    expect(canAutoPromoteRival(t)).toBe(false);
  });
});
