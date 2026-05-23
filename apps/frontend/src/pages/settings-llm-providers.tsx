import { useState } from 'react';
import { Plus, Trash2, Pencil, Star, Zap, TestTube2, Loader2, X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { useAuthStore } from '@/stores/auth.store';
import { useCan } from '@bigbluebam/ui/use-can';
import {
  useLlmProviders,
  useCreateProvider,
  useUpdateProvider,
  useDeleteProvider,
  useTestProvider,
  type LlmProvider,
  type CreateProviderInput,
  type UpdateProviderInput,
} from '@/hooks/use-llm-providers';
import { useProjects } from '@/hooks/use-projects';

// ---------------------------------------------------------------------------
// Provider type badges
// ---------------------------------------------------------------------------

const PROVIDER_TYPE_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openai_compatible: 'OpenAI-Compatible',
};

const PROVIDER_TYPE_COLORS: Record<string, string> = {
  anthropic: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  openai: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  openai_compatible: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
};

const SCOPE_LABELS: Record<string, string> = {
  system: 'System',
  organization: 'Organization',
  project: 'Project',
};

const SCOPE_COLORS: Record<string, string> = {
  system: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  organization: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
  project: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
};

const MODEL_PLACEHOLDERS: Record<string, string> = {
  anthropic: 'e.g. claude-sonnet-4-20250514',
  openai: 'e.g. gpt-4o',
  openai_compatible: 'e.g. llama-3-70b, mistral-large-latest',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettingsLlmProviders() {
  const { user } = useAuthStore();
  // is_superuser stays as-is — it gates the "System (site-wide)" scope
  // option, which is a genuine platform-admin bypass (not a per-action
  // permission). See docs/wave-d-audit/wave-e-C-useCan.md "What stays as-is".
  const isSuperUser = user?.is_superuser === true;
  // Wave E.D: gate Add/Edit/Delete provider buttons on the matrix
  // (POST /llm-providers → bam.llm_provider.create); the per-row edit/delete
  // ops resolve to the same role tier on the backend, so a single create
  // gate matches the prior `isPrivileged = admin|owner|superuser` semantics.
  const isPrivileged = useCan('bam.llm_provider.create');

  const { data: providersResponse, isLoading } = useLlmProviders();
  const { data: projectsResponse } = useProjects();
  const createMutation = useCreateProvider();
  const updateMutation = useUpdateProvider();
  const deleteMutation = useDeleteProvider();
  const testMutation = useTestProvider();

  const providers = providersResponse?.data ?? [];
  const projects = projectsResponse?.data ?? [];

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formProviderType, setFormProviderType] = useState('anthropic');
  const [formModelId, setFormModelId] = useState('');
  const [formApiEndpoint, setFormApiEndpoint] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formScope, setFormScope] = useState<string>('organization');
  const [formProjectId, setFormProjectId] = useState('');
  const [formMaxTokens, setFormMaxTokens] = useState('4096');
  const [formTemperature, setFormTemperature] = useState('0.7');
  const [formMaxRequestsPerHour, setFormMaxRequestsPerHour] = useState('100');
  const [formMaxTokensPerHour, setFormMaxTokensPerHour] = useState('500000');
  const [formIsDefault, setFormIsDefault] = useState(false);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  // Test result state
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string; latency_ms?: number } | null>>({});

  function resetForm() {
    setFormName('');
    setFormProviderType('anthropic');
    setFormModelId('');
    setFormApiEndpoint('');
    setFormApiKey('');
    setFormScope('organization');
    setFormProjectId('');
    setFormMaxTokens('4096');
    setFormTemperature('0.7');
    setFormMaxRequestsPerHour('100');
    setFormMaxTokensPerHour('500000');
    setFormIsDefault(false);
    setFormEnabled(true);
    setFormError(null);
    setEditingId(null);
    setShowForm(false);
  }

  function openCreateForm() {
    resetForm();
    setShowForm(true);
  }

  function openEditForm(provider: LlmProvider) {
    setFormName(provider.name);
    setFormProviderType(provider.provider_type);
    setFormModelId(provider.model_id);
    setFormApiEndpoint(provider.api_endpoint ?? '');
    setFormApiKey(''); // Don't prefill — user must re-enter to change
    setFormScope(provider.scope);
    setFormProjectId(provider.project_id ?? '');
    setFormMaxTokens(String(provider.max_tokens ?? 4096));
    setFormTemperature(String(provider.temperature ?? '0.7'));
    setFormMaxRequestsPerHour(String(provider.max_requests_per_hour ?? 100));
    setFormMaxTokensPerHour(String(provider.max_tokens_per_hour ?? 500000));
    setFormIsDefault(provider.is_default);
    setFormEnabled(provider.enabled);
    setFormError(null);
    setEditingId(provider.id);
    setShowForm(true);
  }

  async function handleSubmit() {
    setFormError(null);

    if (!formName.trim()) {
      setFormError('Name is required');
      return;
    }
    if (!formModelId.trim()) {
      setFormError('Model ID is required');
      return;
    }
    if (formProviderType === 'openai_compatible' && !formApiEndpoint.trim()) {
      setFormError('API Endpoint is required for OpenAI-compatible providers');
      return;
    }

    try {
      if (editingId) {
        // Update
        const data: UpdateProviderInput = {
          name: formName.trim(),
          provider_type: formProviderType,
          model_id: formModelId.trim(),
          api_endpoint: formApiEndpoint.trim() || null,
          max_tokens: parseInt(formMaxTokens, 10) || 4096,
          temperature: parseFloat(formTemperature) || 0.7,
          is_default: formIsDefault,
          enabled: formEnabled,
          max_requests_per_hour: parseInt(formMaxRequestsPerHour, 10) || 100,
          max_tokens_per_hour: parseInt(formMaxTokensPerHour, 10) || 500000,
        };
        // Only include api_key if the user entered a new one
        if (formApiKey.trim()) {
          data.api_key = formApiKey.trim();
        }
        await updateMutation.mutateAsync({ id: editingId, data });
      } else {
        // Create
        if (!formApiKey.trim()) {
          setFormError('API Key is required');
          return;
        }
        const data: CreateProviderInput = {
          scope: formScope,
          name: formName.trim(),
          provider_type: formProviderType,
          model_id: formModelId.trim(),
          api_endpoint: formApiEndpoint.trim() || null,
          api_key: formApiKey.trim(),
          max_tokens: parseInt(formMaxTokens, 10) || 4096,
          temperature: parseFloat(formTemperature) || 0.7,
          is_default: formIsDefault,
          enabled: formEnabled,
          max_requests_per_hour: parseInt(formMaxRequestsPerHour, 10) || 100,
          max_tokens_per_hour: parseInt(formMaxTokensPerHour, 10) || 500000,
        };
        if (formScope === 'project' && formProjectId) {
          data.project_id = formProjectId;
        }
        await createMutation.mutateAsync(data);
      }
      resetForm();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save provider';
      setFormError(message);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMutation.mutateAsync(id);
      setDeleteConfirm(null);
    } catch {
      // Error handled by TanStack Query
    }
  }

  async function handleTest(id: string) {
    setTestResults((prev) => ({ ...prev, [id]: null }));
    try {
      const result = await testMutation.mutateAsync(id);
      setTestResults((prev) => ({ ...prev, [id]: result.data }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Test failed';
      setTestResults((prev) => ({ ...prev, [id]: { success: false, message } }));
    }
  }

  async function handleToggleEnabled(provider: LlmProvider) {
    await updateMutation.mutateAsync({
      id: provider.id,
      data: { enabled: !provider.enabled },
    });
  }

  async function handleToggleDefault(provider: LlmProvider) {
    await updateMutation.mutateAsync({
      id: provider.id,
      data: { is_default: !provider.is_default },
    });
  }

  // Scope options
  const scopeOptions = [
    ...(isSuperUser ? [{ value: 'system', label: 'System (site-wide)' }] : []),
    { value: 'organization', label: 'Organization' },
    { value: 'project', label: 'Project' },
  ];

  const providerTypeOptions = [
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'openai_compatible', label: 'OpenAI-Compatible' },
  ];

  const projectOptions = projects.map((p: { id: string; name: string }) => ({
    value: p.id,
    label: p.name,
  }));

  // -----------------------------------------------------------------------
  // Empty state
  // -----------------------------------------------------------------------
  if (!isLoading && providers.length === 0 && !showForm) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
        <div className="text-center py-12">
          <Zap className="h-12 w-12 text-zinc-300 dark:text-zinc-600 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
            No AI Providers Configured
          </h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-md mx-auto mb-6">
            LLM providers power AI-assisted features like smart authoring, content generation, and
            automated workflows. Configure a provider to enable AI features across your
            organization.
          </p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 max-w-md mx-auto mb-6">
            Providers are resolved hierarchically: Project overrides Organization overrides
            System-wide. Supports Anthropic, OpenAI, and any OpenAI API-compatible endpoint (Azure
            OpenAI, Together AI, local LLMs, etc.).
          </p>
          {isPrivileged && (
            <Button onClick={openCreateForm}>
              <Plus className="h-4 w-4" />
              Add Provider
            </Button>
          )}
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Main view
  // -----------------------------------------------------------------------
  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">AI Providers</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Configure LLM providers for AI-powered features. Resolution order: Project &rarr; Organization &rarr; System.
            </p>
          </div>
          {isPrivileged && !showForm && (
            <Button onClick={openCreateForm} size="sm">
              <Plus className="h-4 w-4" />
              Add Provider
            </Button>
          )}
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
          </div>
        )}

        {/* Provider list */}
        {!isLoading && providers.length > 0 && (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {providers.map((provider) => (
              <div
                key={provider.id}
                className={`py-4 first:pt-0 last:pb-0 ${!provider.enabled ? 'opacity-60' : ''}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                        {provider.name}
                      </span>
                      {provider.is_default && (
                        <Star className="h-4 w-4 text-amber-500 fill-amber-500 shrink-0" />
                      )}
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PROVIDER_TYPE_COLORS[provider.provider_type] ?? 'bg-zinc-100 text-zinc-800'}`}
                      >
                        {PROVIDER_TYPE_LABELS[provider.provider_type] ?? provider.provider_type}
                      </span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${SCOPE_COLORS[provider.scope] ?? 'bg-zinc-100 text-zinc-800'}`}
                      >
                        {SCOPE_LABELS[provider.scope] ?? provider.scope}
                      </span>
                      {!provider.enabled && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          Disabled
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
                      <span>Model: <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">{provider.model_id}</code></span>
                      <span>Key: <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">{provider.api_key_hint}</code></span>
                      {provider.api_endpoint && (
                        <span className="truncate max-w-[200px]">Endpoint: {provider.api_endpoint}</span>
                      )}
                    </div>
                    {/* Test result */}
                    {testResults[provider.id] !== undefined && (
                      <div className={`mt-2 text-xs px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5 ${
                        testResults[provider.id] === null
                          ? 'bg-zinc-100 text-zinc-500'
                          : testResults[provider.id]!.success
                            ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                            : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                      }`}>
                        {testResults[provider.id] === null ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Testing connection...
                          </>
                        ) : (
                          <>
                            {testResults[provider.id]!.success ? 'Connected' : 'Failed'}
                            {' — '}
                            {testResults[provider.id]!.message}
                            {testResults[provider.id]!.latency_ms != null && (
                              <> ({testResults[provider.id]!.latency_ms}ms)</>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  {isPrivileged && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleTest(provider.id)}
                        disabled={testMutation.isPending}
                        className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition-colors"
                        title="Test connection"
                      >
                        <TestTube2 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleToggleDefault(provider)}
                        className="p-1.5 rounded-md text-zinc-400 hover:text-amber-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        title={provider.is_default ? 'Unset as default' : 'Set as default'}
                      >
                        <Star className={`h-4 w-4 ${provider.is_default ? 'text-amber-500 fill-amber-500' : ''}`} />
                      </button>
                      <button
                        onClick={() => handleToggleEnabled(provider)}
                        className={`p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors ${
                          provider.enabled
                            ? 'text-green-500 hover:text-green-700'
                            : 'text-zinc-400 hover:text-zinc-700'
                        }`}
                        title={provider.enabled ? 'Disable' : 'Enable'}
                      >
                        <Zap className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => openEditForm(provider)}
                        className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition-colors"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {deleteConfirm === provider.id ? (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleDelete(provider.id)}
                            loading={deleteMutation.isPending}
                          >
                            Confirm
                          </Button>
                          <button
                            onClick={() => setDeleteConfirm(null)}
                            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirm(provider.id)}
                          className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit form */}
      {showForm && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              {editingId ? 'Edit Provider' : 'Add Provider'}
            </h3>
            <button
              onClick={resetForm}
              className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Name"
              placeholder="e.g. Claude Sonnet 4"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />

            <Select
              label="Provider Type"
              options={providerTypeOptions}
              value={formProviderType}
              onValueChange={setFormProviderType}
            />

            <Input
              label="Model ID"
              placeholder={MODEL_PLACEHOLDERS[formProviderType] ?? 'Model identifier'}
              value={formModelId}
              onChange={(e) => setFormModelId(e.target.value)}
            />

            {formProviderType === 'openai_compatible' && (
              <Input
                label="API Endpoint"
                placeholder="https://your-server.com/v1"
                value={formApiEndpoint}
                onChange={(e) => setFormApiEndpoint(e.target.value)}
              />
            )}

            <Input
              label={editingId ? 'API Key (leave blank to keep current)' : 'API Key'}
              type="password"
              placeholder={editingId ? 'Leave blank to keep existing key' : 'sk-...'}
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
            />

            {!editingId && (
              <Select
                label="Scope"
                options={scopeOptions}
                value={formScope}
                onValueChange={setFormScope}
              />
            )}

            {!editingId && formScope === 'project' && (
              <Select
                label="Project"
                options={projectOptions}
                value={formProjectId}
                onValueChange={setFormProjectId}
                placeholder="Select a project..."
              />
            )}

            <Input
              label="Max Tokens"
              type="number"
              value={formMaxTokens}
              onChange={(e) => setFormMaxTokens(e.target.value)}
            />

            <Input
              label="Temperature"
              type="number"
              value={formTemperature}
              onChange={(e) => setFormTemperature(e.target.value)}
              step="0.1"
              min="0"
              max="2"
            />

            <Input
              label="Max Requests / Hour"
              type="number"
              value={formMaxRequestsPerHour}
              onChange={(e) => setFormMaxRequestsPerHour(e.target.value)}
            />

            <Input
              label="Max Tokens / Hour"
              type="number"
              value={formMaxTokensPerHour}
              onChange={(e) => setFormMaxTokensPerHour(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-6 mt-4">
            <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={formIsDefault}
                onChange={(e) => setFormIsDefault(e.target.checked)}
                className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
              />
              Set as default for this scope
            </label>

            <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={formEnabled}
                onChange={(e) => setFormEnabled(e.target.checked)}
                className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
              />
              Enabled
            </label>
          </div>

          {formError && (
            <div className="mt-4 flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 px-3 py-2 rounded-lg">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {formError}
            </div>
          )}

          <div className="flex items-center gap-3 mt-6">
            <Button
              onClick={handleSubmit}
              loading={createMutation.isPending || updateMutation.isPending}
            >
              {editingId ? 'Save Changes' : 'Add Provider'}
            </Button>
            <Button variant="secondary" onClick={resetForm}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
