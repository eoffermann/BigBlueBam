import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Shield, Building2, FolderKanban, Info, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { useAuthStore } from '@/stores/auth.store';
import { bbbGet } from '@/lib/bbb-api';
import { useEffectivePolicy, useUpdatePolicy, type PolicyScope, type EffectivePolicy } from '@/hooks/use-policies';

// ── Types ────────────────────────────────────────────────────────────

interface BeaconSettingsPageProps {
  onNavigate: (path: string) => void;
}

interface Project {
  id: string;
  name: string;
  slug: string;
}

interface PaginatedResponse<T> {
  data: T[];
}

// ── Main Page ────────────────────────────────────────────────────────

export function BeaconSettingsPage({ onNavigate: _onNavigate }: BeaconSettingsPageProps) {
  const { user } = useAuthStore();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-primary-100 dark:bg-primary-900/30">
              <Shield className="h-4.5 w-4.5 text-primary-600 dark:text-primary-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                Expiry Policy Settings
              </h1>
              <p className="text-xs text-zinc-500">
                Manage knowledge freshness policies across the hierarchy
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-6 flex flex-col gap-8">
        <EffectivePolicyCard />
        {user?.is_superuser && <PolicyEditor scope="System" title="System Policy" icon={Shield} />}
        <PolicyEditor scope="Organization" title="Organization Policy" icon={Building2} />
        <ProjectPolicySection />
      </main>
    </div>
  );
}

// ── Effective Policy Card ────────────────────────────────────────────

function EffectivePolicyCard() {
  const { data: policy, isLoading } = useEffectivePolicy();

  return (
    <section className="rounded-xl border border-primary-200 dark:border-primary-900/50 bg-primary-50/50 dark:bg-primary-900/10 p-6">
      <div className="flex items-center gap-2 mb-3">
        <Info className="h-4 w-4 text-primary-600 dark:text-primary-400" />
        <h2 className="text-sm font-semibold text-primary-700 dark:text-primary-400 uppercase tracking-wider">
          Effective Policy (Your Context)
        </h2>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary-500" />
          <span className="text-sm text-zinc-500">Loading...</span>
        </div>
      ) : policy ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <PolicyValue label="Min Expiry" value={`${policy.min_days} days`} />
          <PolicyValue label="Max Expiry" value={`${policy.max_days} days`} />
          <PolicyValue label="Default Expiry" value={`${policy.default_days} days`} />
          <PolicyValue label="Grace Period" value={`${policy.grace_days} days`} />
        </div>
      ) : (
        <p className="text-sm text-zinc-500">Using system defaults</p>
      )}
    </section>
  );
}

function PolicyValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
        {label}
      </span>
      <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums">{value}</p>
    </div>
  );
}

// ── Policy Editor ────────────────────────────────────────────────────

function PolicyEditor({
  scope,
  title,
  icon: Icon,
  projectId,
  parentPolicy,
}: {
  scope: PolicyScope;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  projectId?: string;
  parentPolicy?: EffectivePolicy | null;
}) {
  const { user } = useAuthStore();
  const updatePolicy = useUpdatePolicy();

  const [minDays, setMinDays] = useState('');
  const [maxDays, setMaxDays] = useState('');
  const [defaultDays, setDefaultDays] = useState('');
  const [graceDays, setGraceDays] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const isReadOnly =
    (scope === 'System' && !user?.is_superuser) ||
    (scope === 'Organization' && !['admin', 'owner'].includes(user?.role ?? '')) ||
    false;

  // Load existing effective policy for this scope to pre-fill the form
  const { data: effective } = useEffectivePolicy(projectId);

  useEffect(() => {
    if (effective) {
      setMinDays(String(effective.min_days));
      setMaxDays(String(effective.max_days));
      setDefaultDays(String(effective.default_days));
      setGraceDays(String(effective.grace_days));
    }
  }, [effective]);

  const validate = (): boolean => {
    const min = Number.parseInt(minDays, 10);
    const max = Number.parseInt(maxDays, 10);
    const def = Number.parseInt(defaultDays, 10);
    const grace = Number.parseInt(graceDays, 10);

    if ([min, max, def, grace].some((v) => isNaN(v) || v < 1)) {
      setValidationError('All values must be positive integers');
      return false;
    }

    if (min > def) {
      setValidationError('Min expiry must be less than or equal to Default');
      return false;
    }

    if (def > max) {
      setValidationError('Default must be less than or equal to Max expiry');
      return false;
    }

    if (parentPolicy) {
      if (min < parentPolicy.min_days) {
        setValidationError(`Min (${min}) is below parent minimum (${parentPolicy.min_days})`);
        return false;
      }
      if (max > parentPolicy.max_days) {
        setValidationError(`Max (${max}) exceeds parent maximum (${parentPolicy.max_days})`);
        return false;
      }
    }

    setValidationError(null);
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;

    setSaved(false);
    setWarnings([]);

    try {
      const result = await updatePolicy.mutateAsync({
        scope,
        organization_id: scope === 'Organization' ? user?.org_id : undefined,
        project_id: projectId,
        min_expiry_days: Number.parseInt(minDays, 10),
        max_expiry_days: Number.parseInt(maxDays, 10),
        default_expiry_days: Number.parseInt(defaultDays, 10),
        grace_period_days: Number.parseInt(graceDays, 10),
      });

      if (result.warnings && result.warnings.length > 0) {
        setWarnings(result.warnings.map((w) => w.message));
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setValidationError((err as Error).message);
    }
  };

  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-zinc-100 dark:bg-zinc-800">
          <Icon className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
          {isReadOnly && (
            <p className="text-xs text-zinc-500">Read-only — requires higher permissions to edit</p>
          )}
        </div>
      </div>

      {parentPolicy && (
        <div className="mb-4 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 px-4 py-2.5 text-xs text-zinc-500 dark:text-zinc-400">
          Parent bounds: {parentPolicy.min_days}–{parentPolicy.max_days} days (default: {parentPolicy.default_days}, grace: {parentPolicy.grace_days})
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Input
          label="Min expiry (days)"
          type="number"
          min={1}
          value={minDays}
          onChange={(e) => { setMinDays(e.target.value); setValidationError(null); }}
          disabled={isReadOnly}
        />
        <Input
          label="Max expiry (days)"
          type="number"
          min={1}
          value={maxDays}
          onChange={(e) => { setMaxDays(e.target.value); setValidationError(null); }}
          disabled={isReadOnly}
        />
        <Input
          label="Default expiry (days)"
          type="number"
          min={1}
          value={defaultDays}
          onChange={(e) => { setDefaultDays(e.target.value); setValidationError(null); }}
          disabled={isReadOnly}
        />
        <Input
          label="Grace period (days)"
          type="number"
          min={1}
          value={graceDays}
          onChange={(e) => { setGraceDays(e.target.value); setValidationError(null); }}
          disabled={isReadOnly}
        />
      </div>

      {validationError && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{validationError}</p>
      )}

      {warnings.length > 0 && (
        <div className="mt-3 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 p-3">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
            <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">Warnings</span>
          </div>
          {warnings.map((w, i) => (
            <p key={i} className="text-xs text-yellow-700 dark:text-yellow-400">{w}</p>
          ))}
        </div>
      )}

      {!isReadOnly && (
        <div className="mt-4 flex items-center gap-3">
          <Button
            size="sm"
            onClick={handleSave}
            loading={updatePolicy.isPending}
          >
            Save Policy
          </Button>
          {saved && (
            <span className="text-sm text-green-600 dark:text-green-400">Saved successfully</span>
          )}
        </div>
      )}
    </section>
  );
}

// ── Project Policy Section ───────────────────────────────────────────

function ProjectPolicySection() {
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');

  // Fetch projects list from Bam API
  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ['bbb-projects'],
    queryFn: () => bbbGet<PaginatedResponse<Project>>('/projects'),
    select: (res) => res.data,
  });

  // Get the parent (org-level) resolved policy to pass bounds to the editor
  const { data: orgPolicy } = useEffectivePolicy();

  const projectOptions = (projectsData ?? []).map((p) => ({
    value: p.id,
    label: p.name,
  }));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-zinc-100 dark:bg-zinc-800">
          <FolderKanban className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
        </div>
        <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Project Policy
        </h3>
      </div>

      <div className="max-w-xs">
        {projectsLoading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary-500" />
            <span className="text-sm text-zinc-500">Loading projects...</span>
          </div>
        ) : (
          <Select
            label="Select a project"
            options={projectOptions}
            value={selectedProjectId || undefined}
            onValueChange={setSelectedProjectId}
            placeholder="Choose project..."
          />
        )}
      </div>

      {selectedProjectId && (
        <PolicyEditor
          key={selectedProjectId}
          scope="Project"
          title={projectsData?.find((p) => p.id === selectedProjectId)?.name ?? 'Project'}
          icon={FolderKanban}
          projectId={selectedProjectId}
          parentPolicy={orgPolicy ?? null}
        />
      )}

      {!selectedProjectId && (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Select a project above to view or edit its expiry policy.
          </p>
        </div>
      )}
    </section>
  );
}
