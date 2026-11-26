import { describe, it, expect } from 'vitest';
import { BASTION_PROBE_KEYS, BastionTemplateKey } from '@bigbluebam/shared';
import {
  FRAMEWORK_TEMPLATES,
  LIBRARY_CONTROLS,
  PROBE_CATALOG,
  crosswalk,
  frameworkTemplate,
  libraryIntegrityProblems,
  requirementsForControl,
  templateControlKeys,
} from '../src/library/index.js';
import { catalogCoversSharedKeys } from '../src/library/probe-catalog.js';
import { ISO27001 } from '../src/library/iso27001.js';
import { SOC2 } from '../src/library/soc2.js';

// Spec 2.1 and 11.1: crosswalk completeness (every SOC 2 and ISO requirement maps to a control),
// referential integrity, and the "own plain-language wording" rule.

describe('framework templates', () => {
  it('ship exactly the template keys the shared enum names', () => {
    expect(FRAMEWORK_TEMPLATES.map((t) => t.template_key).sort()).toEqual([...BastionTemplateKey.options].sort());
    for (const k of BastionTemplateKey.options) expect(frameworkTemplate(k)).toBeDefined();
  });

  it('SOC 2 carries all 33 common criteria CC1.1 to CC9.2', () => {
    const expected = [
      ...[1, 2, 3, 4, 5].map((n) => `CC1.${n}`),
      ...[1, 2, 3].map((n) => `CC2.${n}`),
      ...[1, 2, 3, 4].map((n) => `CC3.${n}`),
      ...[1, 2].map((n) => `CC4.${n}`),
      ...[1, 2, 3].map((n) => `CC5.${n}`),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `CC6.${n}`),
      ...[1, 2, 3, 4, 5].map((n) => `CC7.${n}`),
      'CC8.1',
      'CC9.1',
      'CC9.2',
    ];
    expect(SOC2.requirements.map((r) => r.ref_code)).toEqual(expected);
  });

  it('ISO 27001:2022 carries all 93 Annex A controls (37 + 8 + 14 + 34)', () => {
    const expected = [
      ...Array.from({ length: 37 }, (_, i) => `A.5.${i + 1}`),
      ...Array.from({ length: 8 }, (_, i) => `A.6.${i + 1}`),
      ...Array.from({ length: 14 }, (_, i) => `A.7.${i + 1}`),
      ...Array.from({ length: 34 }, (_, i) => `A.8.${i + 1}`),
    ];
    expect(ISO27001.requirements.map((r) => r.ref_code)).toEqual(expected);
    expect(ISO27001.is_iso).toBe(true);
    expect(SOC2.is_iso).toBe(false);
  });
});

describe('crosswalk', () => {
  it('has no referential integrity problems (every requirement maps to a known control, every control is used)', () => {
    expect(libraryIntegrityProblems()).toEqual([]);
  });

  it('every SOC 2 and ISO requirement maps to at least one control', () => {
    for (const t of FRAMEWORK_TEMPLATES) {
      for (const req of t.requirements) expect(req.control_keys.length, `${t.template_key} ${req.ref_code}`).toBeGreaterThan(0);
    }
  });

  it('shares controls between SOC 2 and ISO 27001 (adopting the second framework reuses them)', () => {
    const shared = crosswalk();
    expect(shared.length).toBeGreaterThanOrEqual(30);
    const mfa = shared.find((c) => c.control_key === 'auth.mfa');
    // Spec 10.2: the MFA control shows "CC6.1" and "A.5.17".
    expect(mfa?.soc2).toContain('CC6.1');
    expect(mfa?.iso27001).toContain('A.5.17');
  });

  it('keeps the ISO premises requirements on a control of their own (so they can be excluded as a group)', () => {
    for (const ref of ['A.7.1', 'A.7.2', 'A.7.3', 'A.7.4', 'A.7.5', 'A.7.6', 'A.7.8', 'A.7.11', 'A.7.12', 'A.7.13']) {
      expect(ISO27001.requirements.find((r) => r.ref_code === ref)?.control_keys).toEqual(['physical.premises']);
    }
  });

  it('the SOC 2 control set is a strict subset of the union once ISO is adopted', () => {
    const soc = new Set(templateControlKeys(SOC2));
    const iso = new Set(templateControlKeys(ISO27001));
    const isoOnly = [...iso].filter((k) => !soc.has(k));
    expect(isoOnly.length).toBeGreaterThan(0);
    expect(requirementsForControl(SOC2, 'data.privacy')).toEqual([]);
  });
});

describe('wording', () => {
  const texts = [
    ...LIBRARY_CONTROLS.flatMap((c) => [
      c.title,
      c.plain_summary,
      ...c.suggested_assertions.map((s) => s.plain_statement),
      ...c.suggested_manual_evidence.flatMap((s) => [s.plain_statement, s.spec.title, s.spec.description]),
    ]),
    ...FRAMEWORK_TEMPLATES.flatMap((t) => [t.name, t.description, ...t.requirements.flatMap((r) => [r.title, r.plain_summary])]),
    ...PROBE_CATALOG.flatMap((p) => [p.title, p.description]),
  ];

  it('never uses an em dash or an en dash', () => {
    for (const t of texts) expect(t, t).not.toMatch(/[–—]/);
  });

  it('every requirement and control has a non-empty plain summary', () => {
    for (const t of FRAMEWORK_TEMPLATES) for (const r of t.requirements) expect(r.plain_summary.length).toBeGreaterThan(10);
    for (const c of LIBRARY_CONTROLS) expect(c.plain_summary.length).toBeGreaterThan(10);
  });

  it('control risk weights stay in 1..5 (the CHECK in migration 0274)', () => {
    for (const c of LIBRARY_CONTROLS) {
      expect(c.risk_weight).toBeGreaterThanOrEqual(1);
      expect(c.risk_weight).toBeLessThanOrEqual(5);
    }
  });

  it('every control offers at least one way to be checked', () => {
    for (const c of LIBRARY_CONTROLS) {
      expect(c.suggested_assertions.length + c.suggested_manual_evidence.length, c.control_key).toBeGreaterThan(0);
    }
  });
});

describe('probe catalog', () => {
  it('has exactly one entry per shared probe key (each names a 0279 definer function)', () => {
    expect(catalogCoversSharedKeys()).toBe(true);
    expect(PROBE_CATALOG.map((p) => p.key).sort()).toEqual([...BASTION_PROBE_KEYS].sort());
  });

  it('library probe suggestions reference catalog keys only', () => {
    const keys = new Set(PROBE_CATALOG.map((p) => p.key));
    for (const c of LIBRARY_CONTROLS) for (const s of c.suggested_assertions) expect(keys.has(s.probe_key), s.probe_key).toBe(true);
  });

  it('marks exactly the change and logging population probes', () => {
    const pop = PROBE_CATALOG.filter((p) => p.population_kind).map((p) => `${p.key}:${p.population_kind}`).sort();
    expect(pop).toEqual([
      'change.merge_reviewed:github_repos',
      'change.merge_traceable:github_repos',
      'logging.retention_floor:blip_apps',
    ]);
  });
});
