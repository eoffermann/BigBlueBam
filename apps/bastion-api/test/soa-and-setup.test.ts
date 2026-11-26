import { describe, it, expect } from 'vitest';
import {
  SoaIncompleteError,
  assertSoaCompleteForPacket,
  soaCompleteness,
  soaCsv,
  soaRows,
  type SoaLink,
} from '../src/library/soa.js';
import { controlsRetiredByArchive, derivedApplicability, setupCounts, setupStateFor } from '../src/library/setup-state.js';
import { ISO27001 } from '../src/library/iso27001.js';
import { SOC2 } from '../src/library/soc2.js';

// Spec 2.1 / 11.1: SoA completeness blocks an ISO packet; "Not set up yet" counting; derived
// applicability; archive retires single-framework controls.

const NOW = '2026-11-26T00:00:00Z';

function isoLinks(decide: (ref: string) => Partial<SoaLink> | null): SoaLink[] {
  const out: SoaLink[] = [];
  for (const req of ISO27001.requirements) {
    for (const k of req.control_keys) {
      const d = decide(req.ref_code);
      out.push({
        ref_code: req.ref_code,
        control_title: k,
        control_status: 'unprovable',
        applicability: 'applicable',
        not_applicable_reason: null,
        decided_at: d ? NOW : null,
        removed_at: null,
        ...(d ?? {}),
      });
    }
  }
  return out;
}

describe('Statement of Applicability completeness', () => {
  it('is incomplete while any Annex A requirement is undecided, and blocks the ISO packet', () => {
    const links = isoLinks((ref) => (ref === 'A.8.34' ? null : {}));
    const c = soaCompleteness(ISO27001, links);
    expect(c.complete).toBe(false);
    expect(c.undecided_ref_codes).toEqual(['A.8.34']);
    expect(() => assertSoaCompleteForPacket(ISO27001, links)).toThrow(SoaIncompleteError);
  });

  it('is incomplete when a requirement has no live link at all', () => {
    const links = isoLinks(() => ({})).filter((l) => l.ref_code !== 'A.5.7');
    const c = soaCompleteness(ISO27001, links);
    expect(c.unmapped_ref_codes).toEqual(['A.5.7']);
    expect(c.complete).toBe(false);
  });

  it('treats a removed link as absent', () => {
    const links = isoLinks(() => ({})).map((l) => (l.ref_code === 'A.5.7' ? { ...l, removed_at: NOW } : l));
    expect(soaCompleteness(ISO27001, links).unmapped_ref_codes).toEqual(['A.5.7']);
  });

  it('is complete when every Annex A requirement has a decision (not applicable counts as a decision)', () => {
    const links = isoLinks((ref) =>
      ref.startsWith('A.7.1') ? { applicability: 'not_applicable', not_applicable_reason: 'No server room' } : {},
    );
    const c = soaCompleteness(ISO27001, links);
    expect(c.complete).toBe(true);
    expect(c.decided_count).toBe(93);
    expect(() => assertSoaCompleteForPacket(ISO27001, links)).not.toThrow();
  });

  it('never gates a SOC 2 packet', () => {
    expect(() => assertSoaCompleteForPacket(SOC2, [])).not.toThrow();
  });

  it('renders one SoA row per Annex A requirement with the justification for exclusions', () => {
    const reason = 'We operate from a shared island hut with no server room';
    const links = isoLinks((ref) => (ref === 'A.7.1' ? { applicability: 'not_applicable', not_applicable_reason: reason } : {}));
    const rows = soaRows(ISO27001, links);
    expect(rows).toHaveLength(93);
    const a71 = rows.find((r) => r.ref_code === 'A.7.1')!;
    expect(a71).toMatchObject({ applicable: 'No', justification: reason, implementing_controls: '' });
    expect(rows.find((r) => r.ref_code === 'A.5.17')).toMatchObject({ applicable: 'Yes', current_status: "Can't prove yet" });
  });

  it('neutralizes formulas in the CSV', () => {
    const links = isoLinks((ref) =>
      ref === 'A.7.1' ? { applicability: 'not_applicable', not_applicable_reason: '=HYPERLINK("x")' } : {},
    );
    const csv = soaCsv(ISO27001, links);
    expect(csv.split('\r\n')[0]).toBe('ref_code,title,applicable,justification,implementing control,current status');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.trim().split('\r\n')).toHaveLength(94);
  });
});

describe('Not set up yet', () => {
  const F1 = 'f1';
  const F2 = 'f2';
  const link = (framework_id: string, applicability = 'applicable') => ({ framework_id, applicability, removed_at: null });

  it('counts a control with no confirmed assertion, or only rejected ones, as not set up', () => {
    const view = new Set([F1]);
    expect(setupStateFor({ lifecycle: 'active', links: [link(F1)], assertions: [] }, view)).toBe('not_set_up');
    expect(
      setupStateFor({ lifecycle: 'active', links: [link(F1)], assertions: [{ review_status: 'rejected' }] }, view),
    ).toBe('not_set_up');
    expect(
      setupStateFor({ lifecycle: 'active', links: [link(F1)], assertions: [{ review_status: 'proposed' }] }, view),
    ).toBe('not_set_up');
    expect(
      setupStateFor({ lifecycle: 'active', links: [link(F1)], assertions: [{ review_status: 'confirmed' }] }, view),
    ).toBe('set_up');
  });

  it('excludes retired controls and controls outside the framework view', () => {
    expect(setupStateFor({ lifecycle: 'retired', links: [link(F1)], assertions: [] }, new Set([F1]))).toBeNull();
    expect(setupStateFor({ lifecycle: 'active', links: [link(F2)], assertions: [] }, new Set([F1]))).toBeNull();
  });

  it('lists a control whose in-view links are all not applicable separately, and leaves it out of the denominator', () => {
    const controls = [
      { lifecycle: 'active', links: [link(F1, 'not_applicable'), link(F2)], assertions: [] },
      { lifecycle: 'active', links: [link(F1)], assertions: [{ review_status: 'confirmed' }] },
      { lifecycle: 'active', links: [link(F1)], assertions: [] },
    ];
    expect(setupCounts(controls, new Set([F1]))).toEqual({ total: 2, set_up: 1, not_set_up: 1, not_applicable: 1 });
    // In F2's view the first control is applicable.
    expect(setupCounts(controls, new Set([F2]))).toEqual({ total: 1, set_up: 0, not_set_up: 1, not_applicable: 0 });
  });

  it('derives org-level applicability: not applicable only when every live link is', () => {
    expect(derivedApplicability([link(F1, 'not_applicable'), link(F2)])).toBe('applicable');
    expect(derivedApplicability([link(F1, 'not_applicable'), link(F2, 'not_applicable')])).toBe('not_applicable');
    expect(derivedApplicability([])).toBe('applicable');
  });
});

describe('archiving a framework', () => {
  it('retires only the controls whose only live links were to it', () => {
    const controls = [
      { id: 'only-soc2', links: [{ framework_id: 'soc', applicability: 'applicable', removed_at: null }] },
      {
        id: 'shared',
        links: [
          { framework_id: 'soc', applicability: 'applicable', removed_at: null },
          { framework_id: 'iso', applicability: 'applicable', removed_at: null },
        ],
      },
      { id: 'only-iso', links: [{ framework_id: 'iso', applicability: 'applicable', removed_at: null }] },
    ];
    expect(controlsRetiredByArchive(controls, 'soc', new Set(['iso']))).toEqual(['only-soc2']);
  });
});
