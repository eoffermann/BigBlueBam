import { useState } from 'react';
import { ShieldAlert, Loader2, Check, X } from 'lucide-react';

// -----------------------------------------------------------------------------
// BurnGateNotice (Burn spec section 7.8 / 9.4).
//
// The ONE Bill-side surface for the Burn pre-transaction gate. It runs an advisory
// precheck against the burn-api gate for an expense the user is creating or approving,
// then renders the verdict note, the FOUR actions on a deny, and exactly TWO member
// labeling options plus "flag for review". It never blocks Bill's own flow: the gate is
// advisory here, and Burn owns the enforcing path.
//
// It talks straight to /burn/api/v1 (same origin behind nginx). Until burn-api is wired
// into the stack (Burn M8/M9) the call may 404; the component degrades silently to nothing
// rather than erroring the expense form.
// -----------------------------------------------------------------------------

interface BurnPrecheckResult {
  precheck_id: string;
  verdict: 'allow' | 'allow_with_note' | 'needs_mapping' | 'deny';
  verdict_reason: string;
  enforced: boolean;
  engagement_id: string | null;
  deliverable_id: string | null;
  consumption_band: string | null;
}

interface Props {
  /** Expense amount in minor units (cents). */
  amount: number;
  currency?: string;
  billable: boolean;
  title?: string;
  description?: string;
  projectId?: string | null;
}

const BURN_BASE = '/burn/api/v1';

async function runPrecheck(input: Props): Promise<BurnPrecheckResult | null> {
  try {
    const res = await fetch(`${BURN_BASE}/precheck`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work_ref_type: 'bill.expense',
        proposed_amount: input.amount,
        currency: (input.currency || 'USD').toUpperCase(),
        title: input.title ?? null,
        description: input.description ?? null,
        project_id: input.projectId ?? null,
      }),
    });
    if (!res.ok) return null; // gate not wired yet, or not permitted here
    const json = await res.json();
    return json.data as BurnPrecheckResult;
  } catch {
    return null; // burn-api unreachable; advisory gate simply not shown
  }
}

async function labelPrecheck(id: string, body: unknown): Promise<void> {
  try {
    await fetch(`${BURN_BASE}/prechecks/${id}/label`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // advisory only
  }
}

export function BurnGateNotice(props: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'hidden'>('idle');
  const [result, setResult] = useState<BurnPrecheckResult | null>(null);
  const [labeled, setLabeled] = useState<string | null>(null);

  // Only billable expenses consume a client envelope; internal costs never gate.
  if (!props.billable || props.amount <= 0) return null;
  if (state === 'hidden') return null;

  const check = async () => {
    setState('loading');
    const r = await runPrecheck(props);
    if (!r) {
      setState('hidden');
      return;
    }
    setResult(r);
    setState('done');
  };

  if (state === 'idle') {
    return (
      <button
        type="button"
        onClick={check}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-600 hover:text-primary-700"
      >
        <ShieldAlert className="h-3.5 w-3.5" /> Check against contract (Burn)
      </button>
    );
  }

  if (state === 'loading') {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking against the contract...
      </div>
    );
  }

  if (!result) return null;

  const isDeny = result.verdict === 'deny';
  const tone = isDeny
    ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-900/10'
    : result.verdict === 'needs_mapping'
      ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/10'
      : 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/10';

  return (
    <div className={`mt-2 rounded-lg border p-3 text-sm ${tone}`}>
      <div className="flex items-center gap-2 font-medium text-zinc-800 dark:text-zinc-100">
        <ShieldAlert className="h-4 w-4" />
        {verdictHeadline(result.verdict)}
        {result.enforced && <span className="text-[11px] font-normal text-zinc-500">enforced</span>}
      </div>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{reasonNote(result.verdict_reason)}</p>

      {/* Four actions on a deny (spec 5.7). These deep-link into Burn, which owns the paths. */}
      {isDeny && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <ActionLink label="Map to deliverable" href="/burn/unscoped" />
          <ActionLink label="Record absorbed cost" href="/burn/gate" />
          <ActionLink label="Raise change order" href="/burn/variances" />
          <ActionLink label="Override" href="/burn/gate" />
        </div>
      )}

      {/* Exactly two non-scoring labeling options plus "flag for review" (spec 7.8). */}
      {!result.enforced && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-zinc-500">Was this right?</span>
          <LabelBtn
            active={labeled === 'right_call'}
            onClick={() => {
              labelPrecheck(result.precheck_id, { advisory_feedback: 'right_call' });
              setLabeled('right_call');
            }}
          >
            <Check className="h-3 w-3" /> Right call
          </LabelBtn>
          <LabelBtn
            active={labeled === 'would_have_mapped'}
            onClick={() => {
              labelPrecheck(result.precheck_id, { advisory_feedback: 'would_have_mapped' });
              setLabeled('would_have_mapped');
            }}
          >
            I'd have mapped it
          </LabelBtn>
          <LabelBtn
            active={labeled === 'flag'}
            onClick={() => {
              labelPrecheck(result.precheck_id, { flag_for_review: true });
              setLabeled('flag');
            }}
          >
            <X className="h-3 w-3" /> Flag for review
          </LabelBtn>
        </div>
      )}
    </div>
  );
}

function ActionLink({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      className="rounded-full border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
    >
      {label}
    </a>
  );
}

function LabelBtn({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium border transition-colors ${
        active
          ? 'bg-primary-600 text-white border-primary-600'
          : 'border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}

function verdictHeadline(v: BurnPrecheckResult['verdict']): string {
  switch (v) {
    case 'deny':
      return 'This charge would be blocked as out of scope.';
    case 'needs_mapping':
      return 'This charge needs mapping to a deliverable.';
    case 'allow_with_note':
      return 'Allowed, with a note.';
    default:
      return 'Within the contract envelope.';
  }
}

function reasonNote(reason: string): string {
  return `Reason: ${reason.replace(/_/g, ' ')}.`;
}
