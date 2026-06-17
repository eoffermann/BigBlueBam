import { useState } from 'react';
import { ArrowLeft, DollarSign, Calendar, Clock, Building2, Trophy, XCircle, Edit2, Trash2, MoreHorizontal, FileText, CalendarDays, CheckSquare, Link2 } from 'lucide-react';
import { Button } from '@/components/common/button';
import { Badge } from '@/components/common/badge';
import { Avatar } from '@/components/common/avatar';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { ActivityTimeline } from '@/components/contacts/activity-timeline';
import { LogActivityForm } from '@/components/contacts/log-activity-form';
import { EditDealDialog } from '@/components/pipeline/edit-deal-dialog';
import { LoseDealDialog } from '@/components/pipeline/lose-deal-dialog';
import { useDeal, useDealStageHistory, useCloseDealWon, useDeleteDeal, useDealRelated } from '@/hooks/use-deals';
import { useDealActivities } from '@/hooks/use-activities';
import { formatCurrency, formatDate, daysInStage, formatRelativeTime } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import { PresenceChipStrip } from '@bigbluebam/ui/presence-chip-strip';

interface DealDetailPageProps {
  dealId: string;
  onNavigate: (path: string) => void;
}

export function DealDetailPage({ dealId, onNavigate }: DealDetailPageProps) {
  const { data: dealData, isLoading } = useDeal(dealId);
  const deal = dealData?.data;

  const { data: historyData } = useDealStageHistory(dealId);
  const stageHistory = historyData?.data ?? [];

  const { data: activitiesData, isLoading: activitiesLoading } = useDealActivities(dealId);
  const { data: relatedData } = useDealRelated(dealId);
  const activities = activitiesData?.data ?? [];

  const closeDealWon = useCloseDealWon();
  const deleteDeal = useDeleteDeal();

  const [showLogActivity, setShowLogActivity] = useState(false);
  const [showEditDeal, setShowEditDeal] = useState(false);
  const [showLoseDeal, setShowLoseDeal] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-zinc-500">Deal not found</p>
        <Button variant="ghost" onClick={() => onNavigate('/')} className="mt-4">
          <ArrowLeft className="h-4 w-4" />
          Back to Pipeline
        </Button>
      </div>
    );
  }

  const days = daysInStage(deal.stage_entered_at);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => onNavigate('/')}
            className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            {deal.name}
          </h1>
          {deal.closed_at ? (
            <Badge variant={deal.close_reason ? 'danger' : 'success'}>
              {deal.close_reason ? 'Lost' : 'Won'}
            </Badge>
          ) : (
            <Badge variant="primary">Open</Badge>
          )}
          <div className="ml-auto">
            <PresenceChipStrip
              url={`${window.location.origin}${window.location.pathname}`}
              surfaceApp="bond"
              surfaceId={deal.id}
              surfaceLabel={deal.name}
            />
          </div>
        </div>

        <div className="flex items-center gap-6 text-sm text-zinc-500">
          {deal.value != null && (
            <span className="flex items-center gap-1.5 text-lg font-bold text-zinc-900 dark:text-zinc-100">
              <DollarSign className="h-5 w-5 text-green-600" />
              {formatCurrency(deal.value, deal.currency)}
            </span>
          )}
          {deal.company_name && (
            <span className="flex items-center gap-1.5">
              <Building2 className="h-4 w-4" />
              <button
                onClick={() => deal.company_id && onNavigate(`/companies/${deal.company_id}`)}
                className="hover:text-primary-600 transition-colors"
              >
                {deal.company_name}
              </button>
            </span>
          )}
          {deal.expected_close_date && (
            <span className="flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              {formatDate(deal.expected_close_date)}
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4" />
            {days} days in stage
          </span>
          {deal.owner_name && (
            <span className="flex items-center gap-1.5">
              <Avatar src={deal.owner_avatar_url} name={deal.owner_name} size="sm" />
              {deal.owner_name}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-4">
          {!deal.closed_at && (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => closeDealWon.mutate(deal.id)}
                loading={closeDealWon.isPending}
              >
                <Trophy className="h-4 w-4 text-green-600" />
                Won
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setShowLoseDeal(true)}
              >
                <XCircle className="h-4 w-4 text-red-500" />
                Lost
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => setShowLogActivity(!showLogActivity)}>
            Log Activity
          </Button>
          <DropdownMenu
            trigger={
              <button className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            }
          >
            <DropdownMenuItem onSelect={() => setShowEditDeal(true)}>
              <Edit2 className="h-4 w-4" />
              Edit Deal
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              destructive
              onSelect={() => {
                deleteDeal.mutate(deal.id);
                onNavigate('/');
              }}
            >
              <Trash2 className="h-4 w-4" />
              Delete Deal
            </DropdownMenuItem>
          </DropdownMenu>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 grid grid-cols-3 divide-x divide-zinc-100 dark:divide-zinc-800">
        {/* Main content - Activity */}
        <div className="col-span-2 p-6 space-y-6 overflow-y-auto">
          {deal.description && (
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Description</h3>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{deal.description}</p>
            </div>
          )}

          {showLogActivity && (
            <LogActivityForm dealId={deal.id} onSuccess={() => setShowLogActivity(false)} />
          )}

          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Activity</h3>
            <ActivityTimeline activities={activities} isLoading={activitiesLoading} />
          </div>
        </div>

        {/* Sidebar - Details & Stage History */}
        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Deal details */}
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Details</h3>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-zinc-500">Probability</dt>
                <dd className="text-zinc-900 dark:text-zinc-100 font-medium">
                  {deal.probability_pct != null ? `${deal.probability_pct}%` : '-'}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Weighted Value</dt>
                <dd className="text-zinc-900 dark:text-zinc-100 font-medium">
                  {formatCurrency(deal.weighted_value, deal.currency)}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Created</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  {formatDate(deal.created_at)}
                </dd>
              </div>
              {deal.closed_at && (
                <div>
                  <dt className="text-zinc-500">Closed</dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">
                    {formatDate(deal.closed_at)}
                  </dd>
                </div>
              )}
              {deal.close_reason && (
                <div>
                  <dt className="text-zinc-500">Close Reason</dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">{deal.close_reason}</dd>
                </div>
              )}
              {deal.lost_to_competitor && (
                <div>
                  <dt className="text-zinc-500">Lost To</dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">{deal.lost_to_competitor}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* Related items */}
          {relatedData?.data && (
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3 flex items-center gap-1.5">
                <Link2 className="h-4 w-4 text-zinc-400" />
                Related
              </h3>
              <div className="space-y-2">
                {(relatedData.data.invoices ?? []).map((inv) => (
                  <button
                    key={inv.id}
                    onClick={() => onNavigate(`/invoices/${inv.id}`)}
                    className="flex items-center gap-2 w-full text-left rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  >
                    <FileText className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                    <span className="truncate text-zinc-700 dark:text-zinc-300">#{inv.number}</span>
                    <span className="ml-auto text-xs text-zinc-400">{inv.status}</span>
                  </button>
                ))}
                {(relatedData.data.events ?? []).map((ev) => (
                  <a
                    key={ev.id}
                    href={`/book/events/${ev.id}`}
                    className="flex items-center gap-2 w-full text-left rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  >
                    <CalendarDays className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                    <span className="truncate text-zinc-700 dark:text-zinc-300">{ev.title}</span>
                    <span className="ml-auto text-xs text-zinc-400">
                      {new Date(ev.start_at).toLocaleDateString()}
                    </span>
                  </a>
                ))}
                {(relatedData.data.tasks ?? []).map((task) => (
                  <a
                    key={task.id}
                    href={`/b3/tasks/ref/${task.human_id}`}
                    className="flex items-center gap-2 w-full text-left rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
                  >
                    <CheckSquare className="h-3.5 w-3.5 text-primary-500 shrink-0" />
                    <span className="text-xs font-mono text-zinc-400 shrink-0">{task.human_id}</span>
                    <span className="truncate text-zinc-700 dark:text-zinc-300">{task.title}</span>
                  </a>
                ))}
                {(relatedData.data.invoices ?? []).length === 0 &&
                  (relatedData.data.events ?? []).length === 0 &&
                  (relatedData.data.tasks ?? []).length === 0 && (
                    <p className="text-xs text-zinc-400 px-2">No related items</p>
                  )}
              </div>
            </div>
          )}

          {/* Stage History */}
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Stage History</h3>
            {stageHistory.length === 0 ? (
              <p className="text-sm text-zinc-500">No stage changes yet</p>
            ) : (
              <div className="space-y-2">
                {stageHistory.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-start gap-2 text-sm"
                  >
                    <div className="h-1.5 w-1.5 rounded-full bg-primary-500 mt-1.5 shrink-0" />
                    <div>
                      <p className="text-zinc-900 dark:text-zinc-100">
                        {entry.from_stage_name ? (
                          <>
                            <span className="text-zinc-500">{entry.from_stage_name}</span>
                            {' → '}
                            <span className="font-medium">{entry.to_stage_name}</span>
                          </>
                        ) : (
                          <span className="font-medium">{entry.to_stage_name}</span>
                        )}
                      </p>
                      <p className="text-xs text-zinc-400">
                        {formatRelativeTime(entry.changed_at)}
                        {entry.changed_by_name && ` by ${entry.changed_by_name}`}
                        {entry.duration_in_stage && ` (${entry.duration_in_stage})`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <EditDealDialog open={showEditDeal} onOpenChange={setShowEditDeal} deal={deal} />
      <LoseDealDialog open={showLoseDeal} onOpenChange={setShowLoseDeal} dealId={deal.id} />
    </div>
  );
}
