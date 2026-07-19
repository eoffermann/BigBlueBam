import { useMemo, useState } from 'react';
import { Users, ExternalLink } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import type { BurnMoneyBlock } from '@bigbluebam/shared';
import {
  useEngagements,
  useAccountFinancials,
  useChainFinancials,
  useQueueHealth,
  type EngagementRow,
} from '@/hooks/use-burn';
import { PageHeader, Card, LoadingState, ErrorState, EmptyState } from '@/components/primitives';
import { ChainStatusBadge, EnvelopeBasisBadge, type BurnChainStatus } from '@/components/badges';
import { MoneyFigure } from '@/components/money-figure';
import { BurnBar } from '@/components/burn-bar';
import { formatCents, cn } from '@/lib/utils';

interface Props {
  onNavigate: (path: string) => void;
}

// A chain is one card. Group engagements by chain_root_id and pick the representative
// (the root, i.e. id === chain_root_id; else the most recent).
function chainRepresentatives(rows: EngagementRow[]): EngagementRow[] {
  const byChain = new Map<string, EngagementRow[]>();
  for (const e of rows) {
    const arr = byChain.get(e.chain_root_id) ?? [];
    arr.push(e);
    byChain.set(e.chain_root_id, arr);
  }
  const reps: EngagementRow[] = [];
  for (const arr of byChain.values()) {
    const root = arr.find((e) => e.id === e.chain_root_id);
    reps.push(root ?? arr.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!);
  }
  return reps.sort((a, b) => a.title.localeCompare(b.title));
}

function accountKey(e: EngagementRow): string {
  return e.braid_profile_id ?? e.account_id ?? e.bill_client_id ?? 'unassigned';
}

export function PortfolioBoardPage({ onNavigate }: Props) {
  const canReadAll = useCan('burn.financials.read_all');
  const [allAccounts, setAllAccounts] = useState(false);
  const { data, isLoading, isError } = useEngagements();
  const { data: health } = useQueueHealth();
  const accountFin = useAccountFinancials(canReadAll && allAccounts);

  const groups = useMemo(() => {
    const reps = chainRepresentatives(data?.data ?? []);
    const byAccount = new Map<string, EngagementRow[]>();
    for (const e of reps) {
      const k = accountKey(e);
      const arr = byAccount.get(k) ?? [];
      arr.push(e);
      byAccount.set(k, arr);
    }
    return Array.from(byAccount.entries());
  }, [data]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Portfolio Board"
        subtitle="One card per engagement chain, grouped by client. The headline figure is labeled from its metric and revenue basis."
        actions={
          canReadAll ? (
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={allAccounts}
                onChange={(e) => setAllAccounts(e.target.checked)}
              />
              All accounts rollup
            </label>
          ) : undefined
        }
      />

      {health?.data && <QueueHealthStrip health={health.data} onNavigate={onNavigate} canReadAll={canReadAll} />}

      {canReadAll && allAccounts && accountFin.data?.data && (
        <Card className="mb-6 p-4">
          <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200 mb-3">
            Account rollup ({accountFin.data.data.length})
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {accountFin.data.data.map((a) => (
              <div key={a.account_key} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                <div className="text-xs text-zinc-400 mb-2 truncate" title={a.account_key}>
                  {a.chain_count} chain{a.chain_count === 1 ? '' : 's'}
                </div>
                <MoneyFigure money={a.money} size="md" />
              </div>
            ))}
          </div>
        </Card>
      )}

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message="Could not load engagements. The burn-api service may not be wired into the stack yet." />
      ) : groups.length === 0 ? (
        <EmptyState
          title="No engagements yet"
          hint="Register a signed SOW, proposal, or engagement letter to start watching work against the contract that paid for it."
        />
      ) : (
        <div className="space-y-8">
          {groups.map(([key, chains]) => (
            <AccountGroup key={key} accountKey={key} chains={chains} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountGroup({
  accountKey: key,
  chains,
  onNavigate,
}: {
  accountKey: string;
  chains: EngagementRow[];
  onNavigate: (path: string) => void;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Users className="h-4 w-4 text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          {key === 'unassigned' ? 'Unassigned client' : `Client ${key.slice(0, 8)}`}
        </h2>
        <span className="text-xs text-zinc-400">
          {chains.length} chain{chains.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {chains.map((c) => (
          <ChainCard key={c.chain_root_id} engagement={c} onNavigate={onNavigate} />
        ))}
      </div>
    </section>
  );
}

function deriveStatus(money: BurnMoneyBlock | undefined, engagement: EngagementRow): BurnChainStatus {
  if (engagement.status === 'draft' || engagement.status === 'extracting') return 'unlinked';
  const pct =
    money && 'contract_consumption_pct' in money ? (money.contract_consumption_pct ?? null) : null;
  if (pct == null) return 'silent';
  if (pct >= 100) return 'overrun';
  if (pct >= 85) return 'at_risk';
  return 'healthy';
}

function ChainCard({ engagement, onNavigate }: { engagement: EngagementRow; onNavigate: (p: string) => void }) {
  const fin = useChainFinancials(engagement.id);
  const money = fin.data?.data.money;
  const status = deriveStatus(money, engagement);
  const consumptionPct =
    money && 'contract_consumption_pct' in money ? money.contract_consumption_pct ?? null : null;

  return (
    <Card className="p-4 hover:border-primary-300 dark:hover:border-primary-700 transition-colors">
      <button
        onClick={() => onNavigate(`/engagements/${engagement.id}`)}
        className="w-full text-left"
      >
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {engagement.title}
              <ExternalLink className="h-3 w-3 text-zinc-300 shrink-0" />
            </div>
            <div className="mt-1 flex items-center gap-2">
              <EnvelopeBasisBadge basis={engagement.envelope_basis as never} />
              <span className="text-[11px] text-zinc-400">{engagement.currency}</span>
            </div>
          </div>
          <ChainStatusBadge status={status} />
        </div>

        {fin.isLoading ? (
          <div className="h-16 flex items-center text-xs text-zinc-400">Loading figures...</div>
        ) : money ? (
          <div className="space-y-3">
            <MoneyFigure money={money} size="md" />
            <BurnBar pct={consumptionPct} showLabel={false} />
          </div>
        ) : (
          <div className="h-16 flex items-center text-xs text-zinc-400">
            No financials yet for this chain.
          </div>
        )}
      </button>
    </Card>
  );
}

function QueueHealthStrip({
  health,
  onNavigate,
  canReadAll,
}: {
  health: import('@/hooks/use-burn').QueueHealth;
  onNavigate: (p: string) => void;
  canReadAll: boolean;
}) {
  const cell = (label: string, value: string, tone?: string) => (
    <div className="min-w-0">
      <div className="text-[11px] text-zinc-400 truncate">{label}</div>
      <div className={cn('text-sm font-semibold', tone ?? 'text-zinc-900 dark:text-zinc-100')}>{value}</div>
    </div>
  );

  // The three unscoped bucket figures are NEVER summed (spec 2.3.8): three cells, three numbers.
  return (
    <button
      onClick={() => onNavigate('/unscoped')}
      className="w-full text-left mb-6"
      title="Open the unscoped queue"
    >
      <Card className="p-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {cell(
            'Sold by nobody',
            canReadAll ? formatCents(health.unscoped_sold_by_nobody) : '—',
            'text-red-600 dark:text-red-400',
          )}
          {cell('Unclassified', canReadAll ? formatCents(health.unscoped_unclassified) : '—')}
          {cell('Outside any contract', canReadAll ? formatCents(health.unscoped_outside_contract) : '—')}
          {cell('Pending review', `${health.pending_review_count}`)}
          {cell('Awaiting valuation', `${health.awaiting_valuation_count} items`)}
        </div>
        <p className="mt-3 text-xs text-zinc-400">{health.statement}</p>
      </Card>
    </button>
  );
}
