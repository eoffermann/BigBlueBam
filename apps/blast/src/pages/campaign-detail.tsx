import { useState } from 'react';
import { ArrowLeft, Send, CheckCircle2, AlertCircle, MailX, Clock } from 'lucide-react';
import {
  useCampaign,
  useCampaignAnalytics,
  useCampaignRecipients,
  useSendCampaign,
  type CampaignRecipient,
} from '@/hooks/use-campaigns';
import { campaignStatusLabel, campaignStatusColor, formatDate, formatNumber, formatPercentage } from '@/lib/utils';
import { PresenceChipStrip } from '@bigbluebam/ui/presence-chip-strip';

interface CampaignDetailPageProps {
  campaignId: string;
  onNavigate: (path: string) => void;
}

function MetricCard({ label, value, subValue }: { label: string; value: string | number; subValue?: string }) {
  return (
    <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-4">
      <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mt-1">{value}</p>
      {subValue && <p className="text-xs text-zinc-500 mt-0.5">{subValue}</p>}
    </div>
  );
}

const RECIPIENTS_PAGE_SIZE = 25;

function formatEventTime(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

function statusIcon(r: CampaignRecipient) {
  const status = r.status;
  if (r.bounced_at || status === 'bounced') {
    return { icon: MailX, color: 'text-red-500', label: r.bounce_type ? `Bounced (${r.bounce_type})` : 'Bounced' };
  }
  if (status === 'failed' || status === 'error') {
    return { icon: AlertCircle, color: 'text-red-500', label: 'Failed' };
  }
  if (status === 'delivered' || r.delivered_at) {
    return { icon: CheckCircle2, color: 'text-green-500', label: 'Delivered' };
  }
  if (status === 'sent' || r.sent_at) {
    return { icon: Send, color: 'text-blue-500', label: 'Sent' };
  }
  return { icon: Clock, color: 'text-zinc-400', label: status || 'Pending' };
}

export function CampaignDetailPage({ campaignId, onNavigate }: CampaignDetailPageProps) {
  const { data: campaignData, isLoading } = useCampaign(campaignId);
  const { data: analyticsData } = useCampaignAnalytics(campaignId);
  const [recipientsOffset, setRecipientsOffset] = useState(0);
  const { data: recipientsData } = useCampaignRecipients(campaignId, {
    limit: RECIPIENTS_PAGE_SIZE,
    offset: recipientsOffset,
  });
  const sendCampaign = useSendCampaign();

  const campaign = campaignData?.data;
  const analytics = analyticsData?.data;
  const recipients = recipientsData?.data ?? [];
  const recipientsTotal = recipientsData?.total ?? 0;

  if (isLoading) {
    return <div className="p-6 text-center text-zinc-500">Loading campaign...</div>;
  }

  if (!campaign) {
    return <div className="p-6 text-center text-zinc-500">Campaign not found</div>;
  }

  const statusColor = campaignStatusColor(campaign.status);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate('/')}
            className="p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{campaign.name}</h1>
            <p className="text-sm text-zinc-500">{campaign.subject}</p>
          </div>
          <span
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium"
            style={{ backgroundColor: `${statusColor}15`, color: statusColor }}
          >
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: statusColor }} />
            {campaignStatusLabel(campaign.status)}
          </span>
          <PresenceChipStrip
            url={`${window.location.origin}${window.location.pathname}`}
            surfaceApp="blast"
            surfaceId={campaign.id}
            surfaceLabel={campaign.name}
          />
        </div>

        {(campaign.status === 'draft' || campaign.status === 'scheduled') && (
          <button
            onClick={() => sendCampaign.mutate(campaign.id)}
            disabled={sendCampaign.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors text-sm font-medium"
          >
            <Send className="h-4 w-4" />
            {sendCampaign.isPending ? 'Sending...' : 'Send Now'}
          </button>
        )}
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard label="Total Sent" value={formatNumber(campaign.total_sent)} />
        <MetricCard label="Delivered" value={formatNumber(campaign.total_delivered)} />
        <MetricCard
          label="Opened"
          value={formatNumber(campaign.total_opened)}
          subValue={analytics ? `${formatPercentage(analytics.open_rate)} open rate` : undefined}
        />
        <MetricCard
          label="Clicked"
          value={formatNumber(campaign.total_clicked)}
          subValue={analytics ? `${formatPercentage(analytics.click_rate)} click rate` : undefined}
        />
      </div>

      {/* Secondary metrics */}
      <div className="grid grid-cols-3 gap-4">
        <MetricCard label="Bounced" value={formatNumber(campaign.total_bounced)} />
        <MetricCard label="Unsubscribed" value={formatNumber(campaign.total_unsubscribed)} />
        <MetricCard label="Complaints" value={formatNumber(campaign.total_complained)} />
      </div>

      {/* Click URLs */}
      {analytics && analytics.click_urls.length > 0 && (
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
            <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Top Clicked Links</h3>
          </div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {analytics.click_urls.map((link, i) => (
                <tr key={i}>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400 truncate max-w-[400px]">
                    {link.url ?? '(unknown)'}
                  </td>
                  <td className="px-4 py-2 text-right font-medium text-zinc-900 dark:text-zinc-100">
                    {formatNumber(link.count)} clicks
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Campaign Details */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Campaign Details</h3>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <dt className="text-zinc-500">From</dt>
          <dd className="text-zinc-900 dark:text-zinc-100">{campaign.from_name} &lt;{campaign.from_email}&gt;</dd>
          <dt className="text-zinc-500">Sent Date</dt>
          <dd className="text-zinc-900 dark:text-zinc-100">{formatDate(campaign.sent_at) || '-'}</dd>
          <dt className="text-zinc-500">Scheduled</dt>
          <dd className="text-zinc-900 dark:text-zinc-100">{formatDate(campaign.scheduled_at) || '-'}</dd>
          <dt className="text-zinc-500">Recipients</dt>
          <dd className="text-zinc-900 dark:text-zinc-100">{campaign.recipient_count ?? '-'}</dd>
          <dt className="text-zinc-500">Created</dt>
          <dd className="text-zinc-900 dark:text-zinc-100">{formatDate(campaign.created_at)}</dd>
        </dl>
      </div>

      {/* Per-recipient engagement timeline */}
      {recipientsTotal > 0 && (
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Recipients</h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                {formatNumber(recipientsTotal)} total — showing {recipients.length
                  ? `${recipientsOffset + 1}-${recipientsOffset + recipients.length}`
                  : 0}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setRecipientsOffset(Math.max(0, recipientsOffset - RECIPIENTS_PAGE_SIZE))}
                disabled={recipientsOffset === 0}
                className="text-xs px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Prev
              </button>
              <button
                onClick={() => setRecipientsOffset(recipientsOffset + RECIPIENTS_PAGE_SIZE)}
                disabled={recipientsOffset + recipients.length >= recipientsTotal}
                className="text-xs px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-800/30">
              <tr>
                <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Email</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Status</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Sent</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Delivered</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-zinc-500">Bounced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {recipients.map((r) => {
                const info = statusIcon(r);
                const Icon = info.icon;
                return (
                  <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors">
                    <td className="px-4 py-2 text-zinc-900 dark:text-zinc-100 font-mono text-xs">
                      {r.to_email}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-flex items-center gap-1 text-xs ${info.color}`}>
                        <Icon className="h-3.5 w-3.5" />
                        {info.label}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-500">
                      {formatEventTime(r.sent_at)}
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-500">
                      {formatEventTime(r.delivered_at)}
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-500">
                      {formatEventTime(r.bounced_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
