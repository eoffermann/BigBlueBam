import { useState } from 'react';
import {
  ArrowLeft,
  Mail,
  Phone,
  Building2,
  Star,
  Edit2,
  Trash2,
  MoreHorizontal,
  Handshake,
} from 'lucide-react';
import { Button } from '@/components/common/button';
import { Badge } from '@/components/common/badge';
import { Avatar } from '@/components/common/avatar';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { ActivityTimeline } from '@/components/contacts/activity-timeline';
import { LogActivityForm } from '@/components/contacts/log-activity-form';
import { useContact, contactDisplayName, useDeleteContact } from '@/hooks/use-contacts';
import { useContactActivities } from '@/hooks/use-activities';
import { cn, lifecycleStageLabel, lifecycleStageColor, formatDate, formatRelativeTime } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import { useBureauLocationLabel } from '@bigbluebam/bureau-client';

interface ContactDetailPageProps {
  contactId: string;
  onNavigate: (path: string) => void;
}

export function ContactDetailPage({ contactId, onNavigate }: ContactDetailPageProps) {
  const { data: contactData, isLoading } = useContact(contactId);
  const contact = contactData?.data;
  // Bureau widget context: show the contact name, not the URL path.
  useBureauLocationLabel(contact ? contactDisplayName(contact) : null);

  const { data: activitiesData, isLoading: activitiesLoading } = useContactActivities(contactId);
  const activities = activitiesData?.data ?? [];

  const deleteContact = useDeleteContact();
  const [showLogActivity, setShowLogActivity] = useState(false);
  const [activeTab, setActiveTab] = useState<'activity' | 'details' | 'deals'>('activity');

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-zinc-500">Contact not found</p>
        <Button variant="ghost" onClick={() => onNavigate('/contacts')} className="mt-4">
          <ArrowLeft className="h-4 w-4" />
          Back to Contacts
        </Button>
      </div>
    );
  }

  const displayName = contactDisplayName(contact);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => onNavigate('/contacts')}
            className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <Avatar src={contact.avatar_url} name={displayName} size="lg" />
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              {displayName}
            </h1>
            <div className="flex items-center gap-3 text-sm text-zinc-500">
              {contact.title && <span>{contact.title}</span>}
              {contact.company_name && (
                <button
                  onClick={() => contact.company_id && onNavigate(`/companies/${contact.company_id}`)}
                  className="flex items-center gap-1 hover:text-primary-600 transition-colors"
                >
                  <Building2 className="h-3.5 w-3.5" />
                  {contact.company_name}
                </button>
              )}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Badge color={lifecycleStageColor(contact.lifecycle_stage)}>
              {lifecycleStageLabel(contact.lifecycle_stage)}
            </Badge>
            <div className="flex items-center gap-1 text-sm">
              <Star className="h-4 w-4 text-yellow-500" />
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">{contact.lead_score}</span>
            </div>
          </div>
        </div>

        {/* Contact info & actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-sm text-zinc-500">
            {contact.email && (
              <a href={`mailto:${contact.email}`} className="flex items-center gap-1.5 hover:text-primary-600 transition-colors">
                <Mail className="h-3.5 w-3.5" />
                {contact.email}
              </a>
            )}
            {contact.phone && (
              <a href={`tel:${contact.phone}`} className="flex items-center gap-1.5 hover:text-primary-600 transition-colors">
                <Phone className="h-3.5 w-3.5" />
                {contact.phone}
              </a>
            )}
            {contact.deal_count > 0 && (
              <span className="flex items-center gap-1.5">
                <Handshake className="h-3.5 w-3.5" />
                {contact.deal_count} deal{contact.deal_count !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
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
              <DropdownMenuItem onSelect={() => {}}>
                <Edit2 className="h-4 w-4" />
                Edit Contact
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => {}}>
                <Handshake className="h-4 w-4" />
                Create Deal
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                onSelect={() => {
                  deleteContact.mutate(contact.id);
                  onNavigate('/contacts');
                }}
              >
                <Trash2 className="h-4 w-4" />
                Delete Contact
              </DropdownMenuItem>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-6 py-2 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
        {(['activity', 'details', 'deals'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'px-4 py-2 text-sm font-medium rounded-lg transition-colors capitalize',
              activeTab === tab
                ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400'
                : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800',
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 p-6 overflow-y-auto">
        {activeTab === 'activity' && (
          <div className="max-w-3xl space-y-6">
            {showLogActivity && (
              <LogActivityForm contactId={contact.id} onSuccess={() => setShowLogActivity(false)} />
            )}
            <ActivityTimeline activities={activities} isLoading={activitiesLoading} />
          </div>
        )}

        {activeTab === 'details' && (
          <div className="max-w-2xl">
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-zinc-500 mb-1">Lead Source</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">{contact.lead_source ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 mb-1">Owner</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">{contact.owner_name ?? 'Unassigned'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 mb-1">City</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">{contact.city ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 mb-1">State/Region</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">{contact.state_region ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 mb-1">Country</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">{contact.country ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 mb-1">Created</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">{formatDate(contact.created_at)}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 mb-1">Last Contacted</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  {contact.last_contacted_at ? formatRelativeTime(contact.last_contacted_at) : 'Never'}
                </dd>
              </div>
            </dl>
          </div>
        )}

        {activeTab === 'deals' && (
          <div className="max-w-3xl text-center py-8 text-sm text-zinc-500">
            {contact.deal_count > 0
              ? `${contact.deal_count} associated deal(s). Click on a deal from the pipeline board to view.`
              : 'No deals associated with this contact.'}
          </div>
        )}
      </div>
    </div>
  );
}
