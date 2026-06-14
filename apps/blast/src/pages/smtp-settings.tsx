import { Server, ExternalLink, Info, ShieldAlert } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';

const SETTINGS_URL = '/b3/settings';

export function SmtpSettingsPage() {
  const user = useAuthStore((s) => s.user);
  const isSuperuser = user?.is_superuser === true;
  const isOrgAdmin = user?.role === 'owner' || user?.role === 'admin';

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">SMTP Settings</h1>
        <p className="text-sm text-zinc-500 mt-1">
          How outbound email delivery is configured for your Blast campaigns
        </p>
      </div>

      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800">
            <Server className="h-5 w-5 text-zinc-500" />
          </div>
          <div>
            <h3 className="font-medium text-zinc-900 dark:text-zinc-100">Platform SMTP</h3>
            <p className="text-xs text-zinc-500">
              A single platform-wide relay sends every Blast campaign
            </p>
          </div>
        </div>

        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Blast does not keep its own SMTP credentials. Outbound email is sent through the
          platform-wide SMTP relay stored in <code className="font-mono text-xs px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">system_settings</code>,
          configured once in the Bam app under{' '}
          <span className="font-medium text-zinc-900 dark:text-zinc-100">Account Settings &rarr; Integrations</span>.
          That relay is used for transactional email <span className="font-medium">and</span> Blast campaigns.
        </p>

        {isSuperuser ? (
          <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
              <p className="text-sm text-blue-800 dark:text-blue-200">
                As a platform SuperUser you manage SMTP under{' '}
                <span className="font-medium">Account Settings &rarr; Integrations</span>. Open
                Account Settings below, then open the{' '}
                <span className="font-medium">Integrations</span> tab to edit the relay.
              </p>
            </div>
            <a
              href={SETTINGS_URL}
              className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium"
            >
              Open Account Settings
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        ) : isOrgAdmin ? (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-4 space-y-3">
            <div className="flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-800 dark:text-amber-200">
                SMTP is managed by a platform SuperUser under{' '}
                <span className="font-medium">Account Settings &rarr; Integrations</span>. You can
                view the current configuration there, but only a SuperUser can change it.
              </p>
            </div>
            <a
              href={SETTINGS_URL}
              className="inline-flex items-center gap-2 px-4 py-2 border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-sm font-medium"
            >
              View in Account Settings
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        ) : (
          <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 p-4">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-zinc-500 mt-0.5 shrink-0" />
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Email delivery for Blast is configured by your platform SuperUser or org admin.
                Contact them to set up or change the SMTP relay used for your campaigns.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
