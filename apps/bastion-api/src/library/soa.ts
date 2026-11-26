// Statement of Applicability (spec 2.1). Pure functions over a framework template and the org's
// requirement links, so the completeness rule is unit-tested without a database and the packet
// builder (M9), the SoA download and the setup wizard all apply the same rule.

import { neutralizeCsvField } from '@bigbluebam/shared';
import type { FrameworkTemplate } from './types.js';

/** One bastion_control_requirements row, as the SoA needs it. */
export interface SoaLink {
  ref_code: string;
  control_title: string;
  control_status: string | null;
  applicability: 'applicable' | 'not_applicable';
  not_applicable_reason: string | null;
  decided_at: Date | string | null;
  removed_at: Date | string | null;
}

export interface SoaCompleteness {
  complete: boolean;
  /** Requirements with no live link to any control. */
  unmapped_ref_codes: string[];
  /** Requirements with at least one link nobody has decided yet. */
  undecided_ref_codes: string[];
  decided_count: number;
  requirement_count: number;
}

function live(links: readonly SoaLink[]): SoaLink[] {
  return links.filter((l) => !l.removed_at);
}

/**
 * Every requirement of the template must have at least one live link, and every live link must
 * carry a decision (decided_at set). A link that defaults to `applicable` without anyone deciding
 * does not count: the Statement of Applicability is a human statement.
 */
export function soaCompleteness(template: FrameworkTemplate, links: readonly SoaLink[]): SoaCompleteness {
  const byRef = new Map<string, SoaLink[]>();
  for (const l of live(links)) {
    const list = byRef.get(l.ref_code) ?? [];
    list.push(l);
    byRef.set(l.ref_code, list);
  }
  const unmapped: string[] = [];
  const undecided: string[] = [];
  let decided = 0;
  for (const req of template.requirements) {
    const ls = byRef.get(req.ref_code) ?? [];
    if (ls.length === 0) {
      unmapped.push(req.ref_code);
      continue;
    }
    if (ls.some((l) => !l.decided_at)) undecided.push(req.ref_code);
    else decided += 1;
  }
  return {
    complete: unmapped.length === 0 && undecided.length === 0,
    unmapped_ref_codes: unmapped,
    undecided_ref_codes: undecided,
    decided_count: decided,
    requirement_count: template.requirements.length,
  };
}

export class SoaIncompleteError extends Error {
  constructor(public readonly completeness: SoaCompleteness) {
    super(
      `The Statement of Applicability is not finished: ${completeness.undecided_ref_codes.length + completeness.unmapped_ref_codes.length} ISO requirements still need a decision.`,
    );
    this.name = 'SoaIncompleteError';
  }
}

/** The gate an ISO audit packet must pass (spec 2.1; the M9 packet builder calls it). */
export function assertSoaCompleteForPacket(template: FrameworkTemplate, links: readonly SoaLink[]): void {
  if (!template.is_iso) return;
  const c = soaCompleteness(template, links);
  if (!c.complete) throw new SoaIncompleteError(c);
}

/** A requirement is applicable when any live link is (spec 2.1 per-requirement applicability). */
export interface SoaRow {
  ref_code: string;
  title: string;
  applicable: 'Yes' | 'No' | 'Not decided';
  justification: string;
  implementing_controls: string;
  current_status: string;
}

const STATUS_WORDS: Record<string, string> = {
  pass: 'Proven',
  fail: 'Not met',
  unprovable: "Can't prove yet",
};

export function soaRows(template: FrameworkTemplate, links: readonly SoaLink[]): SoaRow[] {
  const byRef = new Map<string, SoaLink[]>();
  for (const l of live(links)) {
    const list = byRef.get(l.ref_code) ?? [];
    list.push(l);
    byRef.set(l.ref_code, list);
  }
  return template.requirements.map((req) => {
    const ls = byRef.get(req.ref_code) ?? [];
    const undecided = ls.length === 0 || ls.some((l) => !l.decided_at);
    const applicableLinks = ls.filter((l) => l.applicability === 'applicable');
    const applicable: SoaRow['applicable'] = undecided ? 'Not decided' : applicableLinks.length > 0 ? 'Yes' : 'No';
    const reasons = [...new Set(ls.filter((l) => l.applicability === 'not_applicable').map((l) => l.not_applicable_reason ?? ''))]
      .filter(Boolean)
      .join('; ');
    return {
      ref_code: req.ref_code,
      title: req.title,
      applicable,
      justification: applicable === 'No' ? reasons : applicable === 'Yes' ? req.plain_summary : '',
      implementing_controls: applicableLinks.map((l) => l.control_title).join('; '),
      current_status:
        applicable === 'Yes'
          ? [...new Set(applicableLinks.map((l) => STATUS_WORDS[l.control_status ?? ''] ?? 'Not assessed'))].join('; ')
          : '',
    };
  });
}

/** statement_of_applicability.csv, formula-neutralized (packages/shared/src/csv-safe.ts). */
export function soaCsv(template: FrameworkTemplate, links: readonly SoaLink[]): string {
  const header = ['ref_code', 'title', 'applicable', 'justification', 'implementing control', 'current status'];
  const lines = [header.map(neutralizeCsvField).join(',')];
  for (const row of soaRows(template, links)) {
    lines.push(
      [row.ref_code, row.title, row.applicable, row.justification, row.implementing_controls, row.current_status]
        .map(neutralizeCsvField)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
