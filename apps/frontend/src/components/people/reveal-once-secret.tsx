import { useState } from 'react';

interface RevealOnceSecretProps {
  /** The secret to display (password, API token, …). Shown verbatim. */
  secret: string;
  /**
   * Headline above the code block. Defaults to the generic "shown only once"
   * warning used by both the reset-password and API-key-create flows.
   */
  message?: string;
}

/**
 * Amber "show this once" panel with a copy button. Extracted from the
 * triplicated copy in the People detail pages (reset-password ×2 + API-key
 * create) so every show-once secret renders identically (plan §7 / §12
 * "triplicated show-once secret").
 *
 * The component is presentational only — the caller owns the secret's
 * lifecycle (when it appears, when the dialog closes). It never persists the
 * value anywhere beyond the in-DOM render.
 */
export function RevealOnceSecret({
  secret,
  message = 'This is shown only once. Copy it now.',
}: RevealOnceSecretProps) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:border-amber-900 dark:text-amber-200">
        {message}
      </div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 rounded-md bg-zinc-100 dark:bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-900 dark:text-zinc-100 break-all">
          {secret}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(secret);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="shrink-0 rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
