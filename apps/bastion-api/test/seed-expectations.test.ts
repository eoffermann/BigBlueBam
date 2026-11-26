import { describe, it, expect } from 'vitest';
import { crosswalk, LIBRARY_CONTROLS, requirementsForControl, templateControlKeys } from '../src/library/index.js';
import { SOC2 } from '../src/library/soc2.js';
import { ISO27001 } from '../src/library/iso27001.js';
import { TEMPLATE_BY_GAP_KIND } from '../src/library/fix-templates.js';
import { probeDefinition } from '../src/probes/definitions.js';
import { GAP_WORDS } from '../src/services/fixes.service.js';
// @ts-expect-error plain .mjs with no type declarations in this package
import { BASTION_SEED_EXPECTATIONS as EXP } from '../../../scripts/seed-gilligan/bastion.expectations.mjs';

// BASTION_SEED_EXPECTATIONS holds literals (the .mjs cannot import TypeScript). This test
// re-derives every M3 number from the library so the seed, the Playwright suite and the
// library cannot drift apart (spec 10.3).

describe('BASTION_SEED_EXPECTATIONS matches the library', () => {
  const soc = templateControlKeys(SOC2);
  const iso = templateControlKeys(ISO27001);
  const left: string[] = EXP.leftUnconfirmed;

  it('framework order and names', () => {
    expect(EXP.frameworks.map((f: { templateKey: string }) => f.templateKey)).toEqual(['soc2', 'iso27001']);
    expect(EXP.frameworks[0].name).toBe(SOC2.name);
    expect(EXP.frameworks[1].name).toBe(ISO27001.name);
  });

  it('the four unconfirmed controls are linked in both frameworks', () => {
    expect(left).toHaveLength(4);
    for (const k of left) {
      expect(soc, k).toContain(k);
      expect(iso, k).toContain(k);
    }
  });

  it('SOC 2 view numbers', () => {
    const f = EXP.frameworks[0];
    expect(f.notApplicable).toBe(0);
    expect(f.controlsInView).toBe(soc.length);
    expect(f.notSetUp).toBe(left.length);
    expect(f.setUp).toBe(soc.length - left.length);
  });

  it('ISO view numbers: the premises requirements are the only ISO links of one control', () => {
    const f = EXP.frameworks[1];
    const naRefs: string[] = EXP.iso.notApplicableRefs;
    const excluded = iso.filter((k) => {
      const refs = requirementsForControl(ISO27001, k).map((r) => r.ref_code);
      return refs.length > 0 && refs.every((r) => naRefs.includes(r));
    });
    expect(excluded).toEqual([EXP.iso.notApplicableControlKey]);
    // Every N/A ref links only to that control, so no other control loses a link.
    for (const ref of naRefs) {
      expect(ISO27001.requirements.find((r) => r.ref_code === ref)?.control_keys).toEqual([EXP.iso.notApplicableControlKey]);
    }
    expect(left).not.toContain(EXP.iso.notApplicableControlKey);
    expect(f.notApplicable).toBe(excluded.length);
    expect(f.controlsInView).toBe(iso.length - excluded.length);
    expect(f.notSetUp).toBe(left.length);
    expect(f.setUp).toBe(iso.length - excluded.length - left.length);
  });

  it('shared, total and SoA counts', () => {
    expect(EXP.sharedControlCount).toBe(crosswalk().length);
    expect(EXP.totalControlCount).toBe(new Set([...soc, ...iso]).size);
    expect(EXP.iso.soaRowCount).toBe(ISO27001.requirements.length);
  });

  it('MFA control title and refs', () => {
    const mfa = LIBRARY_CONTROLS.find((c) => c.control_key === EXP.mfa.controlKey)!;
    expect(mfa.title).toBe(EXP.mfa.title);
    const refs = [
      ...requirementsForControl(SOC2, mfa.control_key),
      ...requirementsForControl(ISO27001, mfa.control_key),
    ].map((r) => r.ref_code);
    for (const r of EXP.mfa.refs) expect(refs).toContain(r);
  });

  it('the GitHub population controls carry the change probes', () => {
    EXP.githubPopulation.controlKeys.forEach((k: string, i: number) => {
      const c = LIBRARY_CONTROLS.find((x) => x.control_key === k)!;
      expect(c.suggested_assertions.map((s) => s.probe_key)).toContain(EXP.githubPopulation.probeKeys[i]);
    });
  });

  it('answers all ten profile questions', () => {
    expect(Object.keys(EXP.companyProfile)).toHaveLength(10);
  });

  it('M5: the evidence-backed controls have exactly one manual check of the right kind, in both views', () => {
    const only = (key: string, kind: 'file' | 'attestation_statement') => {
      const c = LIBRARY_CONTROLS.find((x) => x.control_key === key);
      expect(c, key).toBeDefined();
      expect(c?.suggested_assertions, `${key} has no probe check beside the manual one`).toHaveLength(0);
      expect(c?.suggested_manual_evidence.map((m) => m.spec.kind)).toEqual([kind]);
      expect(soc, key).toContain(key);
      expect(iso, key).toContain(key);
      expect(left).not.toContain(key);
    };
    only(EXP.m5.twoStep.controlKey, 'file');
    only(EXP.m5.backgroundChecks.controlKey, 'attestation_statement');
    // So exactly these two count under "Proven by evidence you provided" in either view.
    expect(EXP.m5.provenByEvidence).toBe(2);
    // The 2-Step report's cadence (90 days) covers a report produced two days before seeding.
    const mfa = LIBRARY_CONTROLS.find((x) => x.control_key === EXP.m5.twoStep.controlKey);
    expect(mfa?.suggested_manual_evidence[0]?.spec.cadence_days).toBeGreaterThan(EXP.m5.twoStep.producedDaysAgo);
    // Laptop encryption asks for evidence and gets none in the seed.
    const laptops = LIBRARY_CONTROLS.find((x) => x.control_key === EXP.m5.laptopEncryption.controlKey);
    expect(laptops?.suggested_manual_evidence.length).toBeGreaterThan(0);
    expect(left).not.toContain(EXP.m5.laptopEncryption.controlKey);
  });

  it('M6: the story controls, titles, owners, weights and the gap mapping the stories rely on', () => {
    const m6 = EXP.m6;
    const byKey = (k: string) => LIBRARY_CONTROLS.find((x) => x.control_key === k);
    // Story 6: the key control carries exactly the two key checks the seed revises.
    const keys = byKey(m6.radioRelay.controlKey);
    expect(keys?.title).toBe(m6.radioRelay.controlTitle);
    expect(keys?.suggested_assertions.map((a) => a.probe_key).sort()).toEqual(['keys.max_age', 'keys.unused_active']);
    expect(m6.radioRelay.ageDays).toBeGreaterThan(m6.keyPolicyDays);
    // A single-item exception lasts up to 365 days.
    expect(m6.radioRelay.expiresInDays).toBeLessThanOrEqual(365);
    // Story 4: laptops weigh 5 and have only a manual check, so the gap is manual_missing with an
    // evidence request (spec 2.3 table), and nothing the seed recalibrates outweighs them.
    const laptop = byKey(m6.laptop.controlKey);
    expect(laptop?.title).toBe(m6.laptop.title);
    expect(laptop?.risk_weight).toBe(5);
    expect(laptop?.suggested_assertions).toHaveLength(0);
    expect(TEMPLATE_BY_GAP_KIND.manual_missing).toBe(m6.laptop.fixTemplate);
    for (const [k, w] of Object.entries(m6.riskWeights as Record<string, number>)) {
      expect(byKey(k), k).toBeDefined();
      expect(w).toBeLessThan(5);
    }
    // The seeded evidence request: the 2-Step report's 12 days sit inside the 30-day warning window.
    expect(m6.evidenceRequest.controlKey).toBe(EXP.m5.twoStep.controlKey);
    expect(EXP.m5.twoStep.daysLeft).toBeLessThan(30);
    expect(TEMPLATE_BY_GAP_KIND.manual_expiring).toBe('evidence_request');
    for (const k of m6.professorOwns) {
      expect(byKey(k), k).toBeDefined();
      expect(left).not.toContain(k);
    }
    // Story 5: the code-review control is the merge-reviewed population check from M3.
    expect(EXP.githubPopulation.controlKeys).toContain(m6.codeReview.controlKey);
    expect(byKey(m6.codeReview.controlKey)?.suggested_assertions.map((a) => a.probe_key)).toContain('change.merge_reviewed');
    expect(EXP.githubPopulation.repos).toContain(m6.codeReview.listedNotConnected);
    expect(EXP.githubPopulation.repos).not.toContain(m6.codeReview.unlisted);
    expect(EXP.githubPopulation.repos).toContain(`${m6.codeReview.owner}/${m6.codeReview.prRepo}`);
    expect(GAP_WORDS.population_drift).toBe(m6.codeReview.populationGapWords);
    expect(probeDefinition('change.merge_reviewed')!.explain(
      { probe_key: 'change.merge_reviewed', probe_version: 1, as_of: '', summary: { merges: 1, unreviewed_merges: 1, window_days: 90, repos: [{ reviews_subscribed: null }] }, cited_refs: [], cited_count: 1, overflow_count: 0, population_checked: ['a'] } as never,
      true,
    )).toContain(m6.codeReview.pingNote);
  });

  it('M7: the policy ratio is the audience minus the two castaways who have not read it, in the words the page shows', () => {
    const p = EXP.m7.policy;
    expect(p.audienceEmails).toHaveLength(p.required);
    expect(p.attestedEmails).toHaveLength(p.attested);
    expect(p.attestedEmails.every((e: string) => p.audienceEmails.includes(e))).toBe(true);
    expect(p.attestedEmails).not.toContain('gilligan@gilligantravel.example');
    expect(p.label).toBe(`${p.attested} of ${p.required} have read the current version`);
  });
});
