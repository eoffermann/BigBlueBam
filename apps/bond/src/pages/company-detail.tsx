import { useState } from 'react';
import {
  ArrowLeft,
  Globe,
  Phone,
  Building2,
  Users,
  Handshake,
  Edit2,
  Trash2,
  MoreHorizontal,
  MapPin,
} from 'lucide-react';
import { Button } from '@/components/common/button';
import { Badge } from '@/components/common/badge';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common/dropdown-menu';
import { ActivityTimeline } from '@/components/contacts/activity-timeline';
import { LogActivityForm } from '@/components/contacts/log-activity-form';
import { EditCompanyDialog } from '@/components/companies/edit-company-dialog';
import { useCompany, useDeleteCompany } from '@/hooks/use-companies';
import { useCompanyActivities } from '@/hooks/use-activities';
import { cn, formatCurrencyCompact, formatDate } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

interface CompanyDetailPageProps {
  companyId: string;
  onNavigate: (path: string) => void;
}

export function CompanyDetailPage({ companyId, onNavigate }: CompanyDetailPageProps) {
  const { data: companyData, isLoading } = useCompany(companyId);
  const company = companyData?.data;

  const { data: activitiesData, isLoading: activitiesLoading } = useCompanyActivities(companyId);
  const activities = activitiesData?.data ?? [];

  const deleteCompany = useDeleteCompany();
  const [showLogActivity, setShowLogActivity] = useState(false);
  const [showEditCompany, setShowEditCompany] = useState(false);
  const [activeTab, setActiveTab] = useState<'activity' | 'details' | 'contacts' | 'deals'>('activity');

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  if (!company) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-zinc-500">Company not found</p>
        <Button variant="ghost" onClick={() => onNavigate('/companies')} className="mt-4">
          <ArrowLeft className="h-4 w-4" />
          Back to Companies
        </Button>
      </div>
    );
  }

  const location = [company.city, company.state_region, company.country].filter(Boolean).join(', ');

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-6 py-4 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => onNavigate('/companies')}
            className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          {company.logo_url ? (
            <img
              src={company.logo_url}
              alt={company.name}
              className="h-10 w-10 rounded-lg object-contain bg-zinc-100 dark:bg-zinc-800"
            />
          ) : (
            <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-zinc-100 dark:bg-zinc-800">
              <Building2 className="h-5 w-5 text-zinc-400" />
            </div>
          )}
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              {company.name}
            </h1>
            <div className="flex items-center gap-3 text-sm text-zinc-500">
              {company.industry && <Badge>{company.industry}</Badge>}
              {company.size_bucket && <span>{company.size_bucket} employees</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 text-sm text-zinc-500">
            {company.domain && (
              <a
                href={`https://${company.domain}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 hover:text-primary-600 transition-colors"
              >
                <Globe className="h-3.5 w-3.5" />
                {company.domain}
              </a>
            )}
            {company.phone && (
              <a href={`tel:${company.phone}`} className="flex items-center gap-1.5 hover:text-primary-600 transition-colors">
                <Phone className="h-3.5 w-3.5" />
                {company.phone}
              </a>
            )}
            {location && (
              <span className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5" />
                {location}
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              {company.contact_count} contacts
            </span>
            <span className="flex items-center gap-1.5">
              <Handshake className="h-3.5 w-3.5" />
              {company.deal_count} deals
            </span>
            {company.annual_revenue && (
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {formatCurrencyCompact(company.annual_revenue)} revenue
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
              <DropdownMenuItem onSelect={() => setShowEditCompany(true)}>
                <Edit2 className="h-4 w-4" />
                Edit Company
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                destructive
                onSelect={() => {
                  deleteCompany.mutate(company.id);
                  onNavigate('/companies');
                }}
              >
                <Trash2 className="h-4 w-4" />
                Delete Company
              </DropdownMenuItem>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-6 py-2 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
        {(['activity', 'details', 'contacts', 'deals'] as const).map((tab) => (
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
              <LogActivityForm companyId={company.id} onSuccess={() => setShowLogActivity(false)} />
            )}
            <ActivityTimeline activities={activities} isLoading={activitiesLoading} />
          </div>
        )}

        {activeTab === 'details' && (
          <div className="max-w-2xl">
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-zinc-500 mb-1">Website</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  {company.website ? (
                    <a href={company.website} target="_blank" rel="noopener noreferrer" className="text-primary-600 hover:underline">
                      {company.website}
                    </a>
                  ) : '-'}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500 mb-1">Owner</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">{company.owner_name ?? 'Unassigned'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 mb-1">Address</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">
                  {company.address_line1 ?? '-'}
                  {company.address_line2 && <>, {company.address_line2}</>}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500 mb-1">Created</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">{formatDate(company.created_at)}</dd>
              </div>
            </dl>
          </div>
        )}

        {activeTab === 'contacts' && (
          <div className="max-w-3xl text-center py-8 text-sm text-zinc-500">
            {company.contact_count > 0
              ? `${company.contact_count} contact(s) associated with this company.`
              : 'No contacts associated with this company.'}
          </div>
        )}

        {activeTab === 'deals' && (
          <div className="max-w-3xl text-center py-8 text-sm text-zinc-500">
            {company.deal_count > 0
              ? `${company.deal_count} deal(s) associated with this company.`
              : 'No deals associated with this company.'}
          </div>
        )}
      </div>

      <EditCompanyDialog open={showEditCompany} onOpenChange={setShowEditCompany} company={company} />
    </div>
  );
}
