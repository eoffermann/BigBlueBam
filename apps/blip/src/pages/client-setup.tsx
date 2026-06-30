import { BookOpen } from 'lucide-react';
import { ClientSnippets } from '@/components/client-snippets';

interface ClientSetupPageProps {
  appId: string;
}

const PLACEHOLDER_TOKEN = 'blip_<key_id>_<secret>';

function ingestUrl(): string {
  return `${window.location.origin}/blip/ingest/v1`;
}

export function ClientSetupPage({ appId }: ClientSetupPageProps) {
  void appId;
  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <BookOpen className="h-6 w-6 text-primary-500" />
          Client setup
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Embed one of these snippets in your app, replace the placeholder token with a key minted on
          the Keys page, and POST JSON reports. The only mandatory field is{' '}
          <code className="font-mono">report_type</code>. Everything else is free-form and discovered
          server-side.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 text-sm bg-zinc-50 dark:bg-zinc-800/40">
        <div className="text-zinc-500">Ingest URL</div>
        <code className="font-mono text-zinc-900 dark:text-zinc-100 break-all">{ingestUrl()}</code>
      </div>

      <ClientSnippets ingestUrl={ingestUrl()} token={PLACEHOLDER_TOKEN} />

      <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-4 text-sm text-zinc-600 dark:text-zinc-300 space-y-1">
        <p className="font-medium text-zinc-900 dark:text-zinc-100">Reserved fields</p>
        <p>
          Promoted to indexed columns when present: <code className="font-mono">timestamp</code>,{' '}
          <code className="font-mono">level</code>, <code className="font-mono">session_id</code>,{' '}
          <code className="font-mono">app_version</code>, <code className="font-mono">platform</code>,{' '}
          <code className="font-mono">elapsed_ms</code>, <code className="font-mono">screen_captures</code>.
        </p>
        <p>
          <code className="font-mono">level</code> must be one of{' '}
          <code className="font-mono">debug · info · warn · error · fatal</code> to participate in
          level filtering; any other value is kept in the payload but unleveled.
        </p>
      </div>
    </div>
  );
}
