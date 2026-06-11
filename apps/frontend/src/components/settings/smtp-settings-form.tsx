import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Loader2, CheckCircle2, AlertCircle, Send } from 'lucide-react';
import { api } from '@/lib/api';

interface SmtpTestResult {
  ok: boolean;
  stage: 'config' | 'verify' | 'send';
  message?: string;
  error?: string;
  error_code?: string | null;
  hint?: string | null;
  server_response?: string | null;
  resolved?: { host: string; port: number; secure: boolean; source: string };
}

// ─── Types ────────────────────────────────────────────────────────────────

type SmtpKey = 'smtp_host' | 'smtp_port' | 'smtp_user' | 'smtp_password' | 'smtp_from' | 'smtp_secure';

interface SystemSetting {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: string | null;
}

interface SystemSettingResponse {
  data: SystemSetting;
}

interface SystemSettingsListResponse {
  data: SystemSetting[];
}

interface FormState {
  smtp_host: string;
  smtp_port: string;
  smtp_user: string;
  smtp_password: string;
  smtp_from: string;
  smtp_secure: boolean;
}

const EMPTY_FORM: FormState = {
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_password: '',
  smtp_from: '',
  smtp_secure: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Given the system_settings list, extract the SMTP keys into form state. */
function settingsToForm(settings: SystemSetting[]): FormState {
  const map = new Map(settings.map((s) => [s.key, s.value]));
  const portRaw = map.get('smtp_port');
  const port =
    typeof portRaw === 'number'
      ? String(portRaw)
      : typeof portRaw === 'string'
        ? portRaw
        : '587';
  return {
    smtp_host: typeof map.get('smtp_host') === 'string' ? (map.get('smtp_host') as string) : '',
    smtp_port: port,
    smtp_user: typeof map.get('smtp_user') === 'string' ? (map.get('smtp_user') as string) : '',
    smtp_password:
      typeof map.get('smtp_password') === 'string' ? (map.get('smtp_password') as string) : '',
    smtp_from: typeof map.get('smtp_from') === 'string' ? (map.get('smtp_from') as string) : '',
    smtp_secure: map.get('smtp_secure') === true,
  };
}

// ─── Component ────────────────────────────────────────────────────────────

/**
 * SuperUser-gated editable form for platform-wide SMTP configuration.
 *
 * Reads and writes `smtp_*` keys in the `system_settings` table via
 * `/b3/api/system-settings` (SuperUser-gated on the server side). The
 * worker resolves config DB-first, env-vars-fallback, so any values left
 * empty here fall back to the server's environment variables individually
 * (see apps/worker/src/utils/smtp-config.ts). Changes take effect within
 * 30 seconds (the worker caches resolved config).
 *
 * The SMTP password is stored plaintext in postgres. This is a documented
 * trade-off for self-hosted deployments where the operator controls both
 * the DB and the app. Do NOT use this UI to store SMTP creds for a
 * multi-tenant SaaS unless you also enable column-level encryption.
 */
export function SmtpSettingsForm({ isSuperuser }: { isSuperuser: boolean }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testResult, setTestResult] = useState<SmtpTestResult | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => api.get<SystemSettingsListResponse>('/system-settings'),
    enabled: isSuperuser,
  });

  // Populate form once server data arrives.
  useEffect(() => {
    if (data?.data) {
      setForm(settingsToForm(data.data));
      setDirty(false);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (next: FormState) => {
      // PUT each key. The server's PUT /system-settings/:key endpoint runs
      // the per-key validator, so we send typed values (number for port,
      // boolean for secure) rather than coercing everything to strings.
      const entries: Array<[SmtpKey, unknown]> = [
        ['smtp_host', next.smtp_host],
        ['smtp_port', parseInt(next.smtp_port, 10)],
        ['smtp_user', next.smtp_user],
        ['smtp_password', next.smtp_password],
        ['smtp_from', next.smtp_from],
        ['smtp_secure', next.smtp_secure],
      ];
      for (const [key, value] of entries) {
        // Skip empty-string keys so the operator can partially fill the
        // form and leave the rest falling back to env vars. smtp_secure
        // is always sent because false is a meaningful value.
        if (key !== 'smtp_secure' && (value === '' || value == null)) continue;
        if (key === 'smtp_port' && Number.isNaN(value)) continue;
        await api.put<SystemSettingResponse>(`/system-settings/${key}`, { value });
      }
    },
    onSuccess: () => {
      setSaveState('saved');
      setDirty(false);
      setErrorMsg(null);
      queryClient.invalidateQueries({ queryKey: ['system-settings'] });
      // Auto-clear the success state after 3 seconds.
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 3000);
    },
    onError: (err: unknown) => {
      setSaveState('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    },
  });

  const handleChange = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaveState('idle');
    setErrorMsg(null);
  };

  const handleSave = () => {
    setSaveState('saving');
    saveMutation.mutate(form);
  };

  const testMutation = useMutation({
    mutationFn: async (to: string | null) => {
      const res = await api.post<{ data: SmtpTestResult }>(
        '/system-settings/smtp/test',
        to ? { to } : {},
      );
      return res.data;
    },
    onSuccess: (data) => setTestResult(data),
    onError: (err: unknown) => {
      setTestResult({
        ok: false,
        stage: 'verify',
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const testHostFilled = form.smtp_host.trim().length > 0;

  if (!isSuperuser) {
    // Non-superuser fallback: explain that SMTP is platform-wide and
    // require SuperUser access. Keeps the tab visible but gated.
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
            Email Notifications
          </h2>
          <p className="text-sm text-zinc-500">
            Platform-wide SMTP configuration is managed by SuperUsers. Ask a SuperUser to
            configure email delivery for your installation.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
          Email Notifications (SMTP)
        </h2>
        <p className="text-sm text-zinc-500">
          Platform-wide SMTP relay used for transactional email (password resets, guest
          invites, notifications) and Blast campaigns. Changes take effect within 30 seconds.
        </p>
        <p className="text-xs text-zinc-400 mt-2">
          Any field left blank falls back to the server's environment variable (SMTP_HOST,
          SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM). You can leave everything blank and
          configure via env vars instead — both paths work.
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-zinc-400 py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading current settings…
        </div>
      )}

      {!isLoading && (
        <fieldset className="space-y-4 disabled:opacity-60" disabled={saveMutation.isPending}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="smtp-host"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
              >
                SMTP Host
              </label>
              <input
                id="smtp-host"
                type="text"
                value={form.smtp_host}
                onChange={(e) => handleChange('smtp_host', e.target.value)}
                placeholder="smtp.gmail.com"
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>

            <div>
              <label
                htmlFor="smtp-port"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
              >
                SMTP Port
              </label>
              <input
                id="smtp-port"
                type="number"
                min={1}
                max={65535}
                value={form.smtp_port}
                onChange={(e) => handleChange('smtp_port', e.target.value)}
                placeholder="587"
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <p className="text-xs text-zinc-400 mt-1">
                587 for STARTTLS, 465 for TLS-only, 25 for plain (not recommended).
              </p>
            </div>

            <div>
              <label
                htmlFor="smtp-user"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
              >
                SMTP Username
              </label>
              <input
                id="smtp-user"
                type="text"
                autoComplete="off"
                value={form.smtp_user}
                onChange={(e) => handleChange('smtp_user', e.target.value)}
                placeholder="you@example.com"
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>

            <div>
              <label
                htmlFor="smtp-password"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
              >
                SMTP Password
              </label>
              <input
                id="smtp-password"
                type="password"
                autoComplete="new-password"
                value={form.smtp_password}
                onChange={(e) => handleChange('smtp_password', e.target.value)}
                placeholder="••••••••"
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <p className="text-xs text-zinc-400 mt-1">
                Stored plaintext in the database. For self-hosted installs where the operator
                controls both the DB and the app, this is fine. For multi-tenant SaaS, leave
                this blank and use the SMTP_PASS env var instead.
              </p>
            </div>

            <div>
              <label
                htmlFor="smtp-from"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
              >
                From Address
              </label>
              <input
                id="smtp-from"
                type="email"
                value={form.smtp_from}
                onChange={(e) => handleChange('smtp_from', e.target.value)}
                placeholder="noreply@yourdomain.com"
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>

            <div className="flex items-start gap-2 pt-6">
              <input
                id="smtp-secure"
                type="checkbox"
                checked={form.smtp_secure}
                onChange={(e) => handleChange('smtp_secure', e.target.checked)}
                className="mt-0.5 rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
              />
              <label htmlFor="smtp-secure" className="text-sm text-zinc-700 dark:text-zinc-300">
                <span className="font-medium">Use TLS (secure)</span>
                <p className="text-xs text-zinc-400 mt-0.5">
                  Enable for port 465. Port 587 uses STARTTLS automatically; leave this
                  unchecked.
                </p>
              </label>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2 flex-wrap">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saveMutation.isPending}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-700 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              {saveMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" /> Save SMTP Settings
                </>
              )}
            </button>
            {saveState === 'saved' && (
              <span className="inline-flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" /> Saved — effective within 30 seconds
              </span>
            )}
            {saveState === 'error' && errorMsg && (
              <span className="inline-flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400">
                <AlertCircle className="h-4 w-4" /> {errorMsg}
              </span>
            )}
          </div>

          {/* SMTP test panel */}
          <div className="mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Test SMTP
              </h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                Uses the currently-saved settings. If you just edited the
                form, click Save first — the test reads from the same
                source the worker reads from. "Test connection" verifies
                login + TLS; the email field also sends a one-line test
                message so you can confirm delivery.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => testMutation.mutate(null)}
                disabled={!testHostFilled || testMutation.isPending}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 disabled:opacity-50 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
              >
                {testMutation.isPending && !testTo ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Test connection
              </button>
              <input
                type="email"
                placeholder="you@example.com"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                className="px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500 min-w-[240px]"
              />
              <button
                type="button"
                onClick={() => testMutation.mutate(testTo.trim() || null)}
                disabled={
                  !testHostFilled || !testTo.trim() || testMutation.isPending
                }
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-sm font-medium text-white transition-colors"
              >
                {testMutation.isPending && testTo ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Send test email
              </button>
            </div>
            {testResult && (
              <div
                className={
                  'rounded-md border px-3 py-2 text-sm space-y-1 ' +
                  (testResult.ok
                    ? 'bg-green-50 border-green-200 text-green-900 dark:bg-green-950 dark:border-green-900 dark:text-green-100'
                    : 'bg-red-50 border-red-200 text-red-900 dark:bg-red-950 dark:border-red-900 dark:text-red-100')
                }
              >
                <div className="font-medium">
                  {testResult.ok
                    ? testResult.message ?? 'Success'
                    : `Failed at ${testResult.stage}: ${testResult.error ?? 'Unknown error'}`}
                </div>
                {testResult.hint && (
                  <div className="text-xs">
                    <span className="font-medium">Try:</span> {testResult.hint}
                  </div>
                )}
                {testResult.resolved && (
                  <div className="text-xs font-mono opacity-80">
                    {testResult.resolved.host}:{testResult.resolved.port}{' '}
                    ({testResult.resolved.secure ? 'TLS on' : 'TLS off'}, source:{' '}
                    {testResult.resolved.source})
                  </div>
                )}
                {testResult.server_response && (
                  <div className="text-xs font-mono opacity-80">
                    server replied: {testResult.server_response}
                  </div>
                )}
              </div>
            )}
          </div>
        </fieldset>
      )}
    </div>
  );
}
