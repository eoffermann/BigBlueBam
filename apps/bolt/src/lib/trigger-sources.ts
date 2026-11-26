/**
 * Bolt trigger sources for the SPA (issue #133).
 *
 * The list of valid sources is NOT defined here. It comes from `BOLT_SOURCES`
 * in `@bigbluebam/shared` (packages/shared/src/bolt-sources.ts), the same
 * constant the bolt-api ingest enum, TRIGGER_SOURCES, TriggerSourceV1 and the
 * `bolt_trigger_source` pgEnum derive from. Adding an app there makes it
 * selectable here automatically.
 *
 * Only display metadata (label, badge color) lives in this file, keyed by
 * source. The `Record<TriggerSource, ...>` types make a missing entry a
 * typecheck error, and trigger-sources.test.ts asserts it at runtime too.
 */

import { BOLT_SOURCES, type BoltSource } from '@bigbluebam/shared';

export const TRIGGER_SOURCES = BOLT_SOURCES;

export type TriggerSource = BoltSource;

export const TRIGGER_SOURCE_LABELS: Record<TriggerSource, string> = {
  bam: 'Bam',
  banter: 'Banter',
  beacon: 'Beacon',
  brief: 'Brief',
  helpdesk: 'Helpdesk',
  schedule: 'Schedule',
  bond: 'Bond',
  blast: 'Blast',
  board: 'Board',
  bench: 'Bench',
  bearing: 'Bearing',
  bill: 'Bill',
  book: 'Book',
  blank: 'Blank',
  platform: 'Platform',
  burn: 'Burn',
  bulwark: 'Bulwark',
  braid: 'Braid',
  basis: 'Basis',
  blip: 'Blip',
  blueprint: 'Blueprint',
  bureau: 'Bureau',
  bin: 'Bin',
  bay: 'Bay',
  bursar: 'Bursar',
  bastion: 'Bastion',
};

export const TRIGGER_SOURCE_COLORS: Record<TriggerSource, string> = {
  bam: '#2563eb',
  banter: '#7c3aed',
  beacon: '#059669',
  brief: '#d97706',
  helpdesk: '#dc2626',
  schedule: '#6b7280',
  bond: '#0891b2',
  blast: '#db2777',
  board: '#9333ea',
  bench: '#0d9488',
  bearing: '#ea580c',
  bill: '#16a34a',
  book: '#4f46e5',
  blank: '#64748b',
  platform: '#475569',
  burn: '#b91c1c',
  bulwark: '#1d4ed8',
  braid: '#a21caf',
  basis: '#0369a1',
  blip: '#ca8a04',
  blueprint: '#1e40af',
  bureau: '#7e22ce',
  bin: '#4d7c0f',
  bay: '#0e7490',
  bursar: '#047857',
  bastion: '#334155',
};

/** Selector options, in `BOLT_SOURCES` order. */
export const TRIGGER_SOURCE_OPTIONS: readonly { value: TriggerSource; label: string }[] =
  TRIGGER_SOURCES.map((value) => ({ value, label: TRIGGER_SOURCE_LABELS[value] }));

export function triggerSourceLabel(source: string): string {
  return (TRIGGER_SOURCE_LABELS as Record<string, string>)[source] ?? source;
}

export function triggerSourceColor(source: string): string {
  return (TRIGGER_SOURCE_COLORS as Record<string, string>)[source] ?? '#64748b';
}
