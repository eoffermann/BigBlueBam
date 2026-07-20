// Rival-proposal support tally (spec 4.5), a PURE module so the ">= 2 distinct supporters" rule
// is unit tested without offers existing.
//
// A bidder must not write the ruler. Two colluding bidders - or ONE vendor under two
// bursar_vendors rows, since vendor uniqueness is only on lower(display_name) - could otherwise
// satisfy a ">= 2 offers" rule and inject nodes only they cover, and because gap_adjusted sorts
// the Matrix that directly manipulates the award ranking. So distinctness is by REAL-WORLD
// identity, never vendor_id:
//
//   braid_profile_id  ->  bond_company_id  ->  (a human decision)
//
// A supporter with neither a resolved profile nor a company is 'undecided': it CANNOT be
// auto-counted as distinct; a human must resolve it. Injection- and blanket-suspected offers
// contribute nothing.

export interface RivalSupporter {
  offer_id: string;
  braid_profile_id: string | null;
  bond_company_id: string | null;
  injection_suspected: boolean;
  blanket_suspected: boolean;
}

export interface SupportTally {
  /** Distinct real-world identities among admissible supporters. */
  distinct: number;
  /** Admissible supporters with no resolvable identity (need a human decision). */
  undecided: number;
  /** Admissible offers excluded because they are injection/blanket suspected. */
  excluded: number;
  /** The distinct identity keys, for the audit. */
  keys: string[];
}

export function tallyDistinctSupporters(supporters: RivalSupporter[]): SupportTally {
  const keys = new Set<string>();
  let undecided = 0;
  let excluded = 0;
  for (const s of supporters) {
    if (s.injection_suspected || s.blanket_suspected) {
      excluded += 1;
      continue;
    }
    const key = s.braid_profile_id ?? s.bond_company_id;
    if (key) keys.add(key);
    else undecided += 1;
  }
  return { distinct: keys.size, undecided, excluded, keys: [...keys] };
}

export const DEFAULT_MIN_RIVAL_SUPPORTERS = 2;

/**
 * True when the proposal may be auto-promoted: at least `min` DISTINCT real-world identities
 * back it. Undecided supporters do not count toward the threshold (a human must resolve them
 * first), and suspected offers are already excluded from the tally.
 */
export function canAutoPromoteRival(tally: SupportTally, min = DEFAULT_MIN_RIVAL_SUPPORTERS): boolean {
  return tally.distinct >= min;
}
