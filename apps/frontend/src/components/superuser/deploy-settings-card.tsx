// Wave G — SuperUser Deploy Settings card.
//
// Lives under the Platform tab of the SuperUser console alongside the
// Launchpad and Calling-credentials cards. Backed by the contract in
// `docs/plans/deploy-settings-contract.md` (GET / PUT /superuser/deploy/settings,
// POST /superuser/deploy/verify-repo).
//
// Behaviour notes worth keeping straight:
//   - The token field is intentionally write-only. The GET response only
//     surfaces a boolean (`deploy_github_token_set`) so we render a badge
//     instead of a value. Leaving the field blank on save means "don't
//     touch the stored token"; an explicit "Clear token" button sends
//     `deploy_github_token: null`.
//   - branch and repo URL can both be reset to their hardcoded defaults
//     by saving `null` for that field. The "Reset to defaults" button
//     does this for all four settings at once after a confirmation dialog.
//   - If the backend route isn't deployed yet (404), we render a graceful
//     error state rather than crashing — mirrors the Wave F UI pattern.

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Check,
  Eye,
  EyeOff,
  GitBranch,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react';
import { Button } from '@/components/common/button';
import { Dialog } from '@/components/common/dialog';
import { Input } from '@/components/common/input';
import { ApiError } from '@/lib/api';
import {
  superuserDeployApi,
  type DeploySettingsData,
  type UpdateDeploySettingsInput,
  type VerifyRepoSuccess,
} from '@/lib/api/superuser-deploy';

const QUERY_KEY = ['superuser', 'deploy-settings'] as const;
const STALE_TIME = 60_000; // 1 minute — these settings change very rarely.

interface FormState {
  branch: string;
  repoUrl: string;
  /** "" = "keep existing"; otherwise = new token to set. */
  tokenInput: string;
  /** When true the user has explicitly asked to clear the stored token. */
  clearToken: boolean;
  autoUpdateEnabled: boolean;
}

function settingsToForm(s: DeploySettingsData): FormState {
  return {
    branch: s.deploy_branch ?? '',
    repoUrl: s.deploy_repo_url ?? '',
    tokenInput: '',
    clearToken: false,
    autoUpdateEnabled: s.deploy_auto_update_enabled,
  };
}

/** Diff the form against the last-saved settings and produce a minimal PUT body. */
function buildUpdatePayload(
  form: FormState,
  saved: DeploySettingsData,
): UpdateDeploySettingsInput {
  const body: UpdateDeploySettingsInput = {};

  const trimmedBranch = form.branch.trim();
  const savedBranch = saved.deploy_branch ?? '';
  if (trimmedBranch !== savedBranch) {
    body.deploy_branch = trimmedBranch === '' ? null : trimmedBranch;
  }

  const trimmedRepo = form.repoUrl.trim();
  const savedRepo = saved.deploy_repo_url ?? '';
  if (trimmedRepo !== savedRepo) {
    body.deploy_repo_url = trimmedRepo === '' ? null : trimmedRepo;
  }

  if (form.clearToken) {
    body.deploy_github_token = null;
  } else if (form.tokenInput.length > 0) {
    body.deploy_github_token = form.tokenInput;
  }

  if (form.autoUpdateEnabled !== saved.deploy_auto_update_enabled) {
    body.deploy_auto_update_enabled = form.autoUpdateEnabled;
  }

  return body;
}

export function DeploySettingsCard() {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => superuserDeployApi.getDeploySettings(),
    staleTime: STALE_TIME,
    retry: (failureCount, err) => {
      // Don't hammer a 404 (route not yet deployed) or 403 (permission missing).
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        return false;
      }
      return failureCount < 2;
    },
  });

  const saved = data?.data;

  // Local form state, hydrated from the server response. We keep these
  // separate from `saved` so the user's in-flight edits don't get blown
  // away on every background refetch.
  const [form, setForm] = useState<FormState | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [verifyResult, setVerifyResult] = useState<
    | { kind: 'success'; data: VerifyRepoSuccess }
    | { kind: 'error'; message: string; status?: number }
    | null
  >(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (saved && form === null) {
      setForm(settingsToForm(saved));
    }
  }, [saved, form]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const saveMut = useMutation({
    mutationFn: (body: UpdateDeploySettingsInput) =>
      superuserDeployApi.updateDeploySettings(body),
    onSuccess: (response) => {
      // Hydrate the form from the server's canonical response so the
      // diff baseline lines up with what's actually stored. Clear any
      // stale "Verify" result — it may have been based on a different URL.
      setForm(settingsToForm(response.data));
      setSaveError(null);
      setVerifyResult(null);
      invalidate();
    },
    onError: (err: Error) => {
      setSaveError(err.message);
    },
  });

  const verifyMut = useMutation({
    mutationFn: () => {
      // Use whatever's in the form right now. If the user blanked the
      // URL field we fall back to the resolved default from the GET
      // response (otherwise the server would 400 us on the empty string).
      const formUrl = form?.repoUrl.trim() ?? '';
      const targetUrl =
        formUrl.length > 0 ? formUrl : (saved?.deploy_repo_url ?? '');
      const body: { deploy_repo_url: string; deploy_github_token?: string } = {
        deploy_repo_url: targetUrl,
      };
      // Only pass the token if the user has actually typed one. Otherwise
      // the server uses the stored token (the documented default).
      if (form?.tokenInput && form.tokenInput.length > 0 && !form.clearToken) {
        body.deploy_github_token = form.tokenInput;
      }
      return superuserDeployApi.verifyRepo(body);
    },
    onSuccess: (response) => {
      setVerifyResult({ kind: 'success', data: response.data });
    },
    onError: (err: Error) => {
      const status = err instanceof ApiError ? err.status : undefined;
      setVerifyResult({ kind: 'error', message: err.message, status });
    },
  });

  const resetMut = useMutation({
    mutationFn: () =>
      superuserDeployApi.updateDeploySettings({
        deploy_branch: null,
        deploy_repo_url: null,
        deploy_github_token: null,
        deploy_auto_update_enabled: true,
      }),
    onSuccess: (response) => {
      setForm(settingsToForm(response.data));
      setSaveError(null);
      setVerifyResult(null);
      setConfirmReset(false);
      invalidate();
    },
    onError: (err: Error) => {
      setSaveError(err.message);
      setConfirmReset(false);
    },
  });

  const payload = useMemo(() => {
    if (!form || !saved) return null;
    return buildUpdatePayload(form, saved);
  }, [form, saved]);

  const hasChanges = payload !== null && Object.keys(payload).length > 0;
  const repoPlaceholder = saved?.defaults?.deploy_repo_url
    ? `(default: ${saved.defaults.deploy_repo_url})`
    : '(default: $origin)';
  const branchPlaceholder = saved?.defaults?.deploy_branch ?? 'stable';

  // ─── Render: loading / error gates ────────────────────────────────────────

  if (isLoading) {
    return (
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading deploy settings…
        </div>
      </section>
    );
  }

  if (error) {
    const isApi = error instanceof ApiError;
    const status = isApi ? error.status : undefined;
    const message =
      status === 404
        ? 'The /superuser/deploy/settings endpoint is not available yet. The backend may still be rolling out.'
        : status === 403
          ? 'You do not have permission to view deploy settings. Required: bam.superuser_deploy_settings.get.'
          : (error as Error).message;

    return (
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
            <GitBranch className="h-5 w-5 text-zinc-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Deploy Settings
            </h3>
            <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">Deploy settings unavailable</div>
                <div className="mt-1 text-xs">{message}</div>
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (!form || !saved) {
    // Defensive: query resolved but with no data — shouldn't happen, but
    // avoid rendering broken inputs.
    return null;
  }

  // ─── Render: full card ────────────────────────────────────────────────────

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-100 dark:bg-sky-900/30">
          <GitBranch className="h-5 w-5 text-sky-600 dark:text-sky-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Deploy Settings
          </h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Control which git branch and repo the deploy script pulls from, and
            whether it pulls automatically. The GitHub token is stored
            encrypted; it is only used by the deploy script and never exposed
            back to the UI.
          </p>

          <div className="mt-5 flex flex-col gap-5">
            {/* Branch */}
            <div>
              <label
                htmlFor="deploy-branch"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
              >
                Branch
              </label>
              <Input
                id="deploy-branch"
                value={form.branch}
                onChange={(e) => setForm({ ...form, branch: e.target.value })}
                placeholder={branchPlaceholder}
                maxLength={100}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="mt-1 text-xs text-zinc-500">
                Leave blank to revert to the built-in default
                (<code className="font-mono">{branchPlaceholder}</code>).
              </p>
            </div>

            {/* Repo URL + Verify */}
            <div>
              <label
                htmlFor="deploy-repo-url"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
              >
                Repo URL
              </label>
              <div className="flex items-stretch gap-2">
                <div className="flex-1">
                  <Input
                    id="deploy-repo-url"
                    value={form.repoUrl}
                    onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
                    placeholder={repoPlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => verifyMut.mutate()}
                  loading={verifyMut.isPending}
                  disabled={
                    verifyMut.isPending ||
                    (form.repoUrl.trim() === '' && !saved.deploy_repo_url)
                  }
                  title="Test the repo URL against GitHub"
                >
                  Verify repo
                </Button>
              </div>
              {saved.defaults.deploy_repo_url && form.repoUrl.trim() === '' && (
                <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                  Empty → using <code className="font-mono">{saved.defaults.deploy_repo_url}</code>
                </p>
              )}

              {verifyResult && (
                <div className="mt-2">
                  {verifyResult.kind === 'success' ? (
                    <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-200">
                      <Check className="h-4 w-4 mt-0.5 shrink-0" />
                      <div>
                        <span className="font-medium">
                          {verifyResult.data.owner}/{verifyResult.data.repo}
                        </span>{' '}
                        on default branch{' '}
                        <code className="font-mono text-xs">
                          {verifyResult.data.default_branch}
                        </code>{' '}
                        — {verifyResult.data.private ? 'private' : 'public'}
                        {verifyResult.data.permissions && (
                          <span className="ml-2 text-xs">
                            (perms: {verifyResult.data.permissions.admin ? 'admin' : verifyResult.data.permissions.push ? 'push' : 'pull'})
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-200">
                      <X className="h-4 w-4 mt-0.5 shrink-0" />
                      <div>
                        <span className="font-medium">Verification failed</span>
                        {verifyResult.status !== undefined && (
                          <span className="ml-1 text-xs">
                            (status {verifyResult.status})
                          </span>
                        )}
                        <div className="mt-0.5 text-xs">{verifyResult.message}</div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* GitHub token */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label
                  htmlFor="deploy-github-token"
                  className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
                >
                  GitHub token
                </label>
                {saved.deploy_github_token_set && !form.clearToken ? (
                  <span className="inline-flex items-center rounded-md bg-emerald-100 dark:bg-emerald-900/40 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:text-emerald-200">
                    Token set
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-md bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
                    {form.clearToken ? 'Will be cleared on save' : 'No token'}
                  </span>
                )}
              </div>
              <div className="flex items-stretch gap-2">
                <div className="flex-1 relative">
                  <input
                    id="deploy-github-token"
                    type={showToken ? 'text' : 'password'}
                    value={form.tokenInput}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        tokenInput: e.target.value,
                        // Typing a new token implicitly cancels a pending clear.
                        clearToken: e.target.value.length > 0 ? false : form.clearToken,
                      })
                    }
                    placeholder={
                      saved.deploy_github_token_set
                        ? '••••••••  (leave blank to keep existing)'
                        : 'ghp_...'
                    }
                    autoComplete="new-password"
                    spellCheck={false}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 pr-10 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-700 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 rounded"
                    aria-label={showToken ? 'Hide token' : 'Show token'}
                    title={showToken ? 'Hide token' : 'Show token'}
                  >
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {saved.deploy_github_token_set && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setForm({
                        ...form,
                        tokenInput: '',
                        clearToken: !form.clearToken,
                      })
                    }
                    title={form.clearToken ? 'Undo clear' : 'Clear stored token on save'}
                  >
                    {form.clearToken ? 'Undo' : 'Clear token'}
                  </Button>
                )}
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                Leave blank to keep the existing token. The token is encrypted
                at rest and never returned by the API.
              </p>
            </div>

            {/* Auto-update toggle */}
            <div>
              <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                Auto-update
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    setForm({ ...form, autoUpdateEnabled: !form.autoUpdateEnabled })
                  }
                  className={
                    'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ' +
                    (form.autoUpdateEnabled
                      ? 'bg-primary-600'
                      : 'bg-zinc-300 dark:bg-zinc-700')
                  }
                  role="switch"
                  aria-checked={form.autoUpdateEnabled}
                  aria-label="Auto-update enabled"
                >
                  <span
                    className={
                      'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ' +
                      (form.autoUpdateEnabled ? 'translate-x-5' : 'translate-x-0.5')
                    }
                  />
                </button>
                <span className="text-sm text-zinc-700 dark:text-zinc-300">
                  {form.autoUpdateEnabled
                    ? 'Deploy script will pull updates'
                    : 'Deploy script will skip the pull prompt'}
                </span>
              </div>
            </div>
          </div>

          {/* Action row */}
          <div className="mt-6 flex items-center gap-3">
            <Button
              onClick={() => {
                if (payload) saveMut.mutate(payload);
              }}
              loading={saveMut.isPending}
              disabled={!hasChanges || saveMut.isPending}
            >
              Save changes
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setConfirmReset(true)}
              disabled={saveMut.isPending || resetMut.isPending}
            >
              <RotateCcw className="h-4 w-4" />
              Reset to defaults
            </Button>
            {saveMut.isSuccess && !hasChanges && (
              <span className="text-xs text-green-600 dark:text-green-400">Saved.</span>
            )}
            {saveError && (
              <span className="text-xs text-red-600 dark:text-red-400">
                Failed: {saveError}
              </span>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={confirmReset}
        onOpenChange={(open) => !open && setConfirmReset(false)}
        title="Reset deploy settings to defaults?"
        description="Clears the branch, repo URL, and GitHub token overrides, and re-enables auto-update. The deploy script will fall back to the built-in defaults ('stable' branch + git origin)."
      >
        <div className="flex flex-col gap-4">
          {resetMut.isError && (
            <div className="text-sm text-red-600 dark:text-red-400">
              {(resetMut.error as Error).message}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirmReset(false)}
              disabled={resetMut.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => resetMut.mutate()}
              loading={resetMut.isPending}
            >
              <RotateCcw className="h-4 w-4" />
              Reset to defaults
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
