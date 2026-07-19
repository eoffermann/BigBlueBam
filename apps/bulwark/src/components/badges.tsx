import { cn } from '@/lib/utils';
import type {
  BulwarkObligationType,
  BulwarkReviewStatus,
  BulwarkDeadlineStatus,
  BulwarkNoticeStatus,
  BulwarkRiskSeverity,
  BulwarkValidityStatus,
  BulwarkCollectionStatus,
  BulwarkVendorChaseStatus,
  BulwarkContractStatus,
} from '@bigbluebam/shared';

const pill = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap';
const mono = 'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-mono font-medium whitespace-nowrap';

const NEUTRAL = 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300';
const GREEN = 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
const AMBER = 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
const RED = 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
const BLUE = 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400';
const VIOLET = 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200';

// Types that never auto-arm on model confidence (claim-or-money-waiving set).
const HUMAN_CONFIRM: BulwarkObligationType[] = ['notice', 'lien', 'retention', 'indemnity', 'payment'];

export function ObligationTypeBadge({ type }: { type: BulwarkObligationType }) {
  const critical = HUMAN_CONFIRM.includes(type);
  return (
    <span className={cn(mono, critical ? AMBER : NEUTRAL)} title={critical ? 'Claim/money-waiving type - human confirm required to arm' : undefined}>
      {type}
    </span>
  );
}

export function ReviewStatusBadge({ status }: { status: BulwarkReviewStatus }) {
  const styles: Record<BulwarkReviewStatus, string> = {
    pending_review: AMBER,
    confirmed: GREEN,
    auto_confirmed: BLUE,
    rejected: NEUTRAL,
    superseded: VIOLET,
  };
  const labels: Record<BulwarkReviewStatus, string> = {
    pending_review: 'Pending review',
    confirmed: 'Confirmed',
    auto_confirmed: 'Auto-confirmed',
    rejected: 'Rejected',
    superseded: 'Superseded',
  };
  return <span className={cn(pill, styles[status])}>{labels[status]}</span>;
}

export function DeadlineStatusBadge({ status }: { status: BulwarkDeadlineStatus }) {
  const styles: Record<BulwarkDeadlineStatus, string> = {
    open: BLUE,
    discharged: GREEN,
    missed: RED,
    waived: NEUTRAL,
    voided: VIOLET,
  };
  return <span className={cn(pill, styles[status])}>{status}</span>;
}

export function NoticeStatusBadge({ status }: { status: BulwarkNoticeStatus }) {
  if (status === 'none') return null;
  const styles: Record<BulwarkNoticeStatus, string> = {
    none: NEUTRAL,
    drafted: AMBER,
    approved: BLUE,
    sending: BLUE,
    sent: GREEN,
    send_failed: RED,
    discarded: NEUTRAL,
  };
  return <span className={cn(pill, styles[status])}>notice {status}</span>;
}

export function SeverityBadge({ severity }: { severity: BulwarkRiskSeverity }) {
  const styles: Record<BulwarkRiskSeverity, string> = {
    low: NEUTRAL,
    medium: AMBER,
    high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    critical: RED,
  };
  return <span className={cn(pill, styles[severity])}>{severity}</span>;
}

export function ValidityBadge({ status }: { status: BulwarkValidityStatus }) {
  const styles: Record<BulwarkValidityStatus, string> = {
    unknown: NEUTRAL,
    valid: GREEN,
    expiring: AMBER,
    expired: RED,
  };
  return <span className={cn(pill, styles[status])}>{status}</span>;
}

export function CollectionBadge({ status }: { status: BulwarkCollectionStatus }) {
  const styles: Record<BulwarkCollectionStatus, string> = {
    missing: RED,
    requested: AMBER,
    collected: GREEN,
  };
  return <span className={cn(pill, styles[status])}>{status}</span>;
}

export function VendorChaseBadge({ status }: { status: BulwarkVendorChaseStatus }) {
  const styles: Record<BulwarkVendorChaseStatus, string> = {
    idle: NEUTRAL,
    chasing: AMBER,
    compliant: GREEN,
    blocked: RED,
  };
  return <span className={cn(pill, styles[status])}>{status}</span>;
}

export function ContractStatusBadge({ status }: { status: BulwarkContractStatus }) {
  const styles: Record<BulwarkContractStatus, string> = {
    draft: NEUTRAL,
    extracting: AMBER,
    active: GREEN,
    amended: BLUE,
    expired: NEUTRAL,
    terminated: RED,
  };
  return <span className={cn(pill, styles[status])}>{status}</span>;
}

export function ArmedBadge({ armed }: { armed: boolean }) {
  return (
    <span className={cn(pill, armed ? GREEN : NEUTRAL)}>{armed ? 'armed' : 'unarmed'}</span>
  );
}
