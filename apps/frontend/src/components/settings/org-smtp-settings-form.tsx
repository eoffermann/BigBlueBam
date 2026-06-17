/**
 * Org-level SMTP override (Account Settings → Integrations).
 *
 * When an org configures its own relay here, the org's outbound mail (Blast
 * campaigns, member/guest invitations) sends through it. When left blank, the
 * org falls back to the platform relay (configured by a SuperUser in the
 * SuperUser Console → Platform → Platform SMTP relay) and finally the server
 * env vars. Resolution precedence lives in @bigbluebam/smtp-resolver
 * (resolveSmtpHierarchy): org override → platform → env.
 *
 * Backed by organizations.settings.smtp via dedicated, password-masked routes
 * (GET/PUT/DELETE /org/smtp-settings) so the relay password never leaks on the
 * member-readable GET /org. Gated to org admins/owners via bam.org.update.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mail,
  Save,
  Send,
  Trash2,
} from 'lucide-react';
import { api } from '@/lib/api';

interface OrgSmtpData {
  configured: boolean;
  host: string;
  port: number;
  user: string;
  password: string; // masked sentinel when set, '' when unset
  from: string;
  secure: boolean;
}

interface OrgSmtpTestResult {
  ok: boolean;
  stage: 'config' | 'verify' | 'send';
  message?: string;
  error?: string;
  resolved?: { host: string; port: number; secure: boolean; layer: string };
}

interface FormState {
  host: string;
  port: string;
  user: string;
  password: string;
  from: string;
  secure: boolean;
}

const PASSWORD_MASK = '••••••••';

export function OrgSmtpSettingsForm({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>({
    host: '',
    port: '587',
    user: '',
    password: '',
    from: '',
    secure: false,
  });
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testResult, setTestResult] = useState<OrgSmtpTestResult | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['org-smtp-settings'],
    queryFn: () => api.get<{ data: OrgSmtpData }>('/org/smtp-settings'),
  });

  useEffect(() => {
    if (data?.data) {
      const d = data.data;
      setForm({
        host: d.host ?? '',
        port: String(d.port ?? 587),
        user: d.user ?? '',
        password: d.password ?? '',
        from: d.from ?? '',
        secure: Boolean(d.secure),
      });
      setDirty(false);
    }
  }, [data]);

  const configured = data?.data?.configured ?? false;

  const saveMutation = useMutation({
    mutationFn: (next: FormState) =>
      api.put<{ data: OrgSmtpData }>('/org/smtp-settings', {
        host: next.host,
        port: parseInt(next.port, 10) || 587,
        user: next.user,
        password: next.password,
        from: next.from,
        secure: next.secure,
      }),
    onSuccess: () => {
      setSaveState('saved');
      setDirty(false);
      setErrorMsg(null);
      queryClient.invalidateQueries({ queryKey: ['org-smtp-settings'] });
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 3000);
    },
    onError: (err: unknown) => {
      setSaveState('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => api.delete<{ data: { configured: boolean } }>('/org/smtp-settings'),
    onSuccess: () => {
      setTestResult(null);
      queryClient.invalidateQueries({ queryKey: ['org-smtp-settings'] });
    },
  });

  const testMutation = useMutation({
    mutationFn: async (to: string | null) => {
      const res = await api.post<{ data: OrgSmtpTestResult }>(
        '/org/smtp-settings/test',
        to ? { to } : {},
      );
      return res.data;
    },
    onSuccess: (d) => setTestResult(d),
    onError: (err: unknown) =>
      setTestResult({
        ok: false,
        stage: 'verify',
        error: err instanceof Error ? err.message : String(err),
      }),
  });

  const handleChange = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setSaveState('idle');
    setErrorMsg(null);
  };

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800">
          <Mail className="h-5 w-5 text-zinc-500" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
            Organization Email (SMTP)
          </h2>
          <p className="text-sm text-zinc-500">
            Send this organization's email (Blast campaigns and invitations)
            through your own SMTP relay. Leave blank to use the platform relay
            instead. Changes take effect within 30 seconds.
          </p>
          {configured ? (
            <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Using this org's own relay
            </p>
          ) : (
            <p className="mt-2 text-xs text-zinc-400">
              No org relay set. Falling back to the platform relay.
            </p>
          )}
          {!canEdit && (
            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              You need the admin or owner role to change these settings.
            </p>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400 py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading current settings...
        </div>
      ) : (
        <fieldset className="space-y-4 disabled:opacity-60" disabled={!canEdit || saveMutation.isPending}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="org-smtp-host" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                SMTP Host
              </label>
              <input
                id="org-smtp-host"
                type="text"
                value={form.host}
                onChange={(e) => handleChange('host', e.target.value)}
                placeholder="smtp.yourdomain.com"
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label htmlFor="org-smtp-port" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                SMTP Port
              </label>
              <input
                id="org-smtp-port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => handleChange('port', e.target.value)}
                placeholder="587"
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <p className="text-xs text-zinc-400 mt-1">587 for STARTTLS, 465 for TLS-only.</p>
            </div>
            <div>
              <label htmlFor="org-smtp-user" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                SMTP Username
              </label>
              <input
                id="org-smtp-user"
                type="text"
                autoComplete="off"
                value={form.user}
                onChange={(e) => handleChange('user', e.target.value)}
                placeholder="you@yourdomain.com"
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label htmlFor="org-smtp-password" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                SMTP Password
              </label>
              <input
                id="org-smtp-password"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => handleChange('password', e.target.value)}
                placeholder={configured ? PASSWORD_MASK : ''}
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <p className="text-xs text-zinc-400 mt-1">
                Leave the dots in place to keep the current password unchanged.
              </p>
            </div>
            <div>
              <label htmlFor="org-smtp-from" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                From Address
              </label>
              <input
                id="org-smtp-from"
                type="email"
                value={form.from}
                onChange={(e) => handleChange('from', e.target.value)}
                placeholder="noreply@yourdomain.com"
                className="w-full px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="flex items-start gap-2 pt-6">
              <input
                id="org-smtp-secure"
                type="checkbox"
                checked={form.secure}
                onChange={(e) => handleChange('secure', e.target.checked)}
                className="mt-0.5 rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
              />
              <label htmlFor="org-smtp-secure" className="text-sm text-zinc-700 dark:text-zinc-300">
                <span className="font-medium">Use TLS (secure)</span>
                <p className="text-xs text-zinc-400 mt-0.5">Enable for port 465; leave off for 587 (STARTTLS).</p>
              </label>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2 flex-wrap">
            <button
              type="button"
              onClick={() => saveMutation.mutate(form)}
              disabled={!dirty || !form.host.trim() || saveMutation.isPending}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-600 hover:bg-primary-700 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save org SMTP
            </button>
            {configured && (
              <button
                type="button"
                onClick={() => clearMutation.mutate()}
                disabled={clearMutation.isPending}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 text-sm font-medium transition-colors"
              >
                {clearMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Use platform relay
              </button>
            )}
            {saveState === 'saved' && (
              <span className="inline-flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" /> Saved
              </span>
            )}
            {saveState === 'error' && errorMsg && (
              <span className="inline-flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400">
                <AlertCircle className="h-4 w-4" /> {errorMsg}
              </span>
            )}
          </div>

          {/* Test panel — verifies the EFFECTIVE relay (org or platform fallback). */}
          <div className="mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Test relay</h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                Verifies the relay that will actually send (your org override if
                set, otherwise the platform relay). Save first if you just edited
                the form. "Test connection" checks login and TLS; the email field
                also sends a one-line message.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => testMutation.mutate(null)}
                disabled={testMutation.isPending}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 disabled:opacity-50 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
              >
                {testMutation.isPending && !testTo ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
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
                disabled={!testTo.trim() || testMutation.isPending}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-sm font-medium text-white transition-colors"
              >
                {testMutation.isPending && testTo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
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
                {testResult.resolved && (
                  <div className="text-xs font-mono opacity-80">
                    {testResult.resolved.host}:{testResult.resolved.port} (
                    {testResult.resolved.secure ? 'TLS on' : 'TLS off'}, relay: {testResult.resolved.layer})
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
