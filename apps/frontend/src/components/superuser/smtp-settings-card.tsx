/**
 * SuperUser Console → Platform → Platform SMTP relay.
 *
 * This is the canonical home for the platform-wide outbound mail relay.
 * The platform uses it for new-org-setup invitation emails, the
 * password-reset fallback, and system/emergency + reporting alerts — and as
 * the fallback relay for any org that has NOT configured its own SMTP under
 * its org settings.
 *
 * The editable form itself lives in SmtpSettingsForm (shared with the legacy
 * Account Settings → Integrations surface during the migration window). This
 * card just supplies the SuperUser Console chrome + framing and embeds it.
 * Backed by system_settings smtp_* rows via /system-settings (SuperUser-gated
 * on the server). Resolution precedence (org override → platform → env) lives
 * in @bigbluebam/smtp-resolver.
 */
import { Mail } from 'lucide-react';
import { SmtpSettingsForm } from '@/components/settings/smtp-settings-form';

export function SmtpSettingsCard() {
  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30">
          <Mail className="h-5 w-5 text-blue-600 dark:text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Platform SMTP relay
          </h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            The platform-wide outbound mail relay. Used for new-org-setup
            invitations, the password-reset fallback, and system and reporting
            alerts. It is also the fallback relay for any organization that has
            not configured its own SMTP under its org settings.
          </p>
          <div className="mt-4">
            <SmtpSettingsForm isSuperuser />
          </div>
        </div>
      </div>
    </section>
  );
}
