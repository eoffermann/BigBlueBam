// The Bastion library (spec 2.1): the internal control catalog, the built-in framework templates,
// the static SOC 2 to ISO 27001 crosswalk derived from them, and the closed probe menu.

import type { BastionTemplateKey } from '@bigbluebam/shared';
import { LIBRARY_CONTROLS, libraryControl, type LibraryControl } from './controls.js';
import { ISO27001 } from './iso27001.js';
import { SOC2 } from './soc2.js';
import type { FrameworkTemplate, TemplateRequirement } from './types.js';

export * from './types.js';
export { LIBRARY_CONTROLS, libraryControl } from './controls.js';
export type { LibraryControl, ManualSuggestion, ProbeSuggestion } from './controls.js';
export { PROBE_CATALOG, probeEntry, publicProbeCatalog } from './probe-catalog.js';

export const FRAMEWORK_TEMPLATES: readonly FrameworkTemplate[] = [SOC2, ISO27001];

export function frameworkTemplate(key: string): FrameworkTemplate | undefined {
  return FRAMEWORK_TEMPLATES.find((t) => t.template_key === key);
}

export function requireTemplate(key: BastionTemplateKey | string): FrameworkTemplate {
  const t = frameworkTemplate(key);
  if (!t) throw new Error(`unknown framework template ${key}`);
  return t;
}

/** The control keys a template's requirements name, in first-seen order. */
export function templateControlKeys(template: FrameworkTemplate): string[] {
  const seen = new Set<string>();
  for (const req of template.requirements) for (const k of req.control_keys) seen.add(k);
  return [...seen];
}

/** Library controls a template needs, in catalog order. */
export function templateControls(template: FrameworkTemplate): LibraryControl[] {
  const keys = new Set(templateControlKeys(template));
  return LIBRARY_CONTROLS.filter((c) => keys.has(c.control_key));
}

/** For one control key, the requirements of one template that name it. */
export function requirementsForControl(template: FrameworkTemplate, controlKey: string): TemplateRequirement[] {
  return template.requirements.filter((r) => r.control_keys.includes(controlKey));
}

/**
 * The static crosswalk: control keys that satisfy requirements in both SOC 2 and ISO 27001, with
 * the reference codes on each side. Adopting the second framework reuses these controls.
 */
export function crosswalk(): Array<{ control_key: string; soc2: string[]; iso27001: string[] }> {
  const out: Array<{ control_key: string; soc2: string[]; iso27001: string[] }> = [];
  for (const c of LIBRARY_CONTROLS) {
    const soc2 = requirementsForControl(SOC2, c.control_key).map((r) => r.ref_code);
    const iso = requirementsForControl(ISO27001, c.control_key).map((r) => r.ref_code);
    if (soc2.length > 0 && iso.length > 0) out.push({ control_key: c.control_key, soc2, iso27001: iso });
  }
  return out;
}

/** Referential integrity problems in the library (tested to be empty). */
export function libraryIntegrityProblems(): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const c of LIBRARY_CONTROLS) {
    if (keys.has(c.control_key)) problems.push(`duplicate control_key ${c.control_key}`);
    keys.add(c.control_key);
  }
  for (const t of FRAMEWORK_TEMPLATES) {
    const refs = new Set<string>();
    for (const req of t.requirements) {
      if (refs.has(req.ref_code)) problems.push(`${t.template_key}: duplicate ref_code ${req.ref_code}`);
      refs.add(req.ref_code);
      if (req.control_keys.length === 0) problems.push(`${t.template_key} ${req.ref_code}: maps to no control`);
      for (const k of req.control_keys) {
        if (!libraryControl(k)) problems.push(`${t.template_key} ${req.ref_code}: unknown control_key ${k}`);
      }
    }
  }
  for (const c of LIBRARY_CONTROLS) {
    const used = FRAMEWORK_TEMPLATES.some((t) => requirementsForControl(t, c.control_key).length > 0);
    if (!used) problems.push(`control ${c.control_key} is not named by any requirement`);
  }
  return problems;
}
