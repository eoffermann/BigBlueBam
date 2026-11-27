import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { configHealthApi } from '@/lib/api/config-health';

/**
 * SuperUser-only banner for deployment configuration problems, mainly an
 * unset INTERNAL_SERVICE_SECRET: the internal service-to-service routes fail
 * closed without it, so automations and cross-app notifications quietly stop
 * working. Renders nothing for non-SuperUsers and when nothing needs fixing.
 * Read-only: the fix is an environment change plus a restart, and the
 * expanded view says exactly which setting to change.
 */
export function DeploymentHealthBanner() {
  const { user } = useAuthStore();
  const isSuper = user?.is_superuser === true;
  const [expanded, setExpanded] = useState(false);

  const { data } = useQuery({
    queryKey: ['deployment', 'config-health'],
    queryFn: () => configHealthApi.getHealth(),
    enabled: isSuper,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  const result = data?.data;
  if (!isSuper || !result || result.overall === 'ok') return null;

  const shown = result.items.filter((i) => i.status !== 'ok');
  const problems = shown.filter((i) => i.status === 'critical' || i.status === 'warning');
  const critical = result.overall === 'critical';

  const barColor = critical
    ? 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-800 dark:text-red-300'
    : 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-300';

  const badge = (status: string) =>
    status === 'critical' ? 'bg-red-600 text-white' : status === 'warning' ? 'bg-amber-500 text-white' : 'bg-zinc-500 text-white';

  return (
    <div className={`border-b text-sm shrink-0 ${barColor}`}>
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {critical ? <ShieldAlert className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
          <span className="truncate">
            <strong className="font-semibold">Deployment configuration needs attention:</strong>{' '}
            {problems.length} setting{problems.length === 1 ? '' : 's'} to fix
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 transition-colors"
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {expanded ? 'Hide' : 'How to fix'}
        </button>
      </div>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {shown.map((item) => (
            <div
              key={item.key}
              className="rounded-md bg-white/60 dark:bg-black/20 border border-black/5 dark:border-white/10 p-3"
            >
              <div className="font-semibold flex items-center gap-2">
                {item.label}
                <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${badge(item.status)}`}>
                  {item.status}
                </span>
              </div>
              <div className="mt-0.5 opacity-90">{item.detail}</div>
              <div className="mt-1 text-xs opacity-80">{item.remediation}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
