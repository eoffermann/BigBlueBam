// "Not set up yet" (spec 2.3) as a pure rule, so the Controls list, the setup wizard, the
// seed expectations and (from M5) the Readiness numbers count it the same way.
//
// Over active controls with at least one live link in the selected framework view:
//   not_applicable : every in-view link is not_applicable (excluded and listed separately)
//   set_up         : at least one confirmed assertion
//   not_set_up     : no confirmed assertion, or every assertion rejected

import type { BastionSetupState } from '@bigbluebam/shared';

export interface SetupLink {
  framework_id: string;
  applicability: string;
  removed_at: Date | string | null;
}

export interface SetupControl {
  lifecycle: string;
  links: SetupLink[];
  assertions: Array<{ review_status: string }>;
}

/**
 * @param viewFrameworkIds the framework view: one framework id, or every non-archived framework
 *   when no framework is selected.
 */
export function setupStateFor(control: SetupControl, viewFrameworkIds: ReadonlySet<string>): BastionSetupState | null {
  if (control.lifecycle !== 'active') return null;
  const inView = control.links.filter((l) => !l.removed_at && viewFrameworkIds.has(l.framework_id));
  if (inView.length === 0) return null;
  if (inView.every((l) => l.applicability === 'not_applicable')) return 'not_applicable';
  return control.assertions.some((a) => a.review_status === 'confirmed') ? 'set_up' : 'not_set_up';
}

export interface SetupCounts {
  /** Controls counted in the view (set_up + not_set_up); the denominator. */
  total: number;
  set_up: number;
  not_set_up: number;
  not_applicable: number;
}

export function setupCounts(controls: readonly SetupControl[], viewFrameworkIds: ReadonlySet<string>): SetupCounts {
  const out: SetupCounts = { total: 0, set_up: 0, not_set_up: 0, not_applicable: 0 };
  for (const c of controls) {
    const s = setupStateFor(c, viewFrameworkIds);
    if (s === null) continue;
    out[s] += 1;
    if (s !== 'not_applicable') out.total += 1;
  }
  return out;
}

/**
 * A control's org-level applicability is derived: not_applicable only when every live link (in
 * any framework) is. Such a control is not evaluated (spec 2.1).
 */
export function derivedApplicability(links: readonly SetupLink[]): 'applicable' | 'not_applicable' {
  const live = links.filter((l) => !l.removed_at);
  return live.length > 0 && live.every((l) => l.applicability === 'not_applicable') ? 'not_applicable' : 'applicable';
}

/**
 * Archiving a framework retires every control whose only live links were to that framework
 * (spec 2.1). Returns the control ids to retire.
 */
export function controlsRetiredByArchive(
  controls: ReadonlyArray<{ id: string; links: SetupLink[] }>,
  archivedFrameworkId: string,
  otherActiveFrameworkIds: ReadonlySet<string>,
): string[] {
  return controls
    .filter((c) => {
      const live = c.links.filter((l) => !l.removed_at);
      const here = live.some((l) => l.framework_id === archivedFrameworkId);
      const elsewhere = live.some((l) => otherActiveFrameworkIds.has(l.framework_id));
      return here && !elsewhere;
    })
    .map((c) => c.id);
}
