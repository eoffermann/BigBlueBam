import { describe, it, expect } from 'vitest';
import { crosswalk, LIBRARY_CONTROLS, requirementsForControl, templateControlKeys } from '../src/library/index.js';
import { SOC2 } from '../src/library/soc2.js';
import { ISO27001 } from '../src/library/iso27001.js';
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
});
