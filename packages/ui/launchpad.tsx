/**
 * Canonical Launchpad component — shared across all BigBlueBam apps.
 *
 * Every frontend app imports this file via a Vite alias:
 *   '@bigbluebam/ui/launchpad' → '<root>/packages/ui/launchpad.tsx'
 *
 * To update the Launchpad, edit THIS file — all apps pick it up on rebuild.
 */

import { useEffect, useRef, useCallback, useState, type FC } from 'react';
import {
  LayoutDashboard,
  MessageCircle,
  BookOpen,
  FileText,
  Zap,
  Target,
  PenTool,
  Headset,
  X,
  LayoutGrid,
  Handshake,
  Mail,
  BarChart3,
  Calendar,
  ClipboardList,
  DollarSign,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

interface AppDef {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  color: string;
  path: string;
}

const APPS: AppDef[] = [
  { id: 'b3', name: 'Bam', description: 'Project Management', icon: LayoutDashboard, color: '#2563eb', path: '/b3/' },
  { id: 'banter', name: 'Banter', description: 'Team Messaging', icon: MessageCircle, color: '#7c3aed', path: '/banter/' },
  { id: 'beacon', name: 'Beacon', description: 'Knowledge Base', icon: BookOpen, color: '#059669', path: '/beacon/' },
  { id: 'bond', name: 'Bond', description: 'CRM', icon: Handshake, color: '#0891b2', path: '/bond/' },
  { id: 'blast', name: 'Blast', description: 'Email Campaigns', icon: Mail, color: '#dc2626', path: '/blast/' },
  { id: 'bill', name: 'Bill', description: 'Invoicing & Billing', icon: DollarSign, color: '#16a34a', path: '/bill/' },
  { id: 'blank', name: 'Blank', description: 'Forms & Surveys', icon: ClipboardList, color: '#7c3aed', path: '/blank/' },
  { id: 'book', name: 'Book', description: 'Scheduling & Calendar', icon: Calendar, color: '#2563eb', path: '/book/' },
  { id: 'bench', name: 'Bench', description: 'Analytics', icon: BarChart3, color: '#2563eb', path: '/bench/' },
  { id: 'brief', name: 'Brief', description: 'Documents', icon: FileText, color: '#d97706', path: '/brief/' },
  { id: 'bolt', name: 'Bolt', description: 'Automations', icon: Zap, color: '#dc2626', path: '/bolt/' },
  { id: 'bearing', name: 'Bearing', description: 'Goals & OKRs', icon: Target, color: '#0d9488', path: '/bearing/' },
  { id: 'board', name: 'Board', description: 'Whiteboards', icon: PenTool, color: '#6366f1', path: '/board/' },
  { id: 'blueprint', name: 'Blueprint', description: 'Diagrams & Flows', icon: Sparkles, color: '#0ea5e9', path: '/blueprint/' },
  { id: 'helpdesk', name: 'Helpdesk', description: 'Customer Support', icon: Headset, color: '#be123c', path: '/helpdesk/' },
];

/* ------------------------------------------------------------------ */
/*  Launchpad trigger button                                          */
/* ------------------------------------------------------------------ */

export { LayoutGrid };

interface LaunchpadTriggerProps {
  onClick: () => void;
}

export const LaunchpadTrigger: FC<LaunchpadTriggerProps> = ({ onClick }) => (
  <button
    onClick={onClick}
    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
    title="Launchpad — switch between apps"
  >
    <LayoutGrid className="h-4 w-4" />
    <span className="hidden sm:inline">Launchpad</span>
  </button>
);

/* ------------------------------------------------------------------ */
/*  Launchpad overlay                                                 */
/* ------------------------------------------------------------------ */

interface LaunchpadProps {
  isOpen: boolean;
  onClose: () => void;
  currentApp: string;
}

// `null` while we haven't fetched yet (fall back to all apps), then either an
// allowed-id Set or `null` if the resolver fails. We cache across opens so the
// dialog feels instant on second use.
let cachedEnabledIds: Set<string> | null = null;
let cacheFetchedAt = 0;
const CACHE_TTL_MS = 60_000;

async function fetchEnabledAppIds(): Promise<Set<string> | null> {
  // The endpoint is registered on the Bam api at /b3/api/launchpad/apps.
  // Every app served by the same nginx host can reach it; cookies/auth are
  // shared on the same origin. We fail open (return null → render all apps)
  // so a transient API error never makes the launcher look empty.
  try {
    const res = await fetch('/b3/api/launchpad/apps', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { enabled?: unknown } };
    const enabled = json.data?.enabled;
    if (!Array.isArray(enabled)) return null;
    return new Set(enabled.filter((x): x is string => typeof x === 'string'));
  } catch {
    return null;
  }
}

export function Launchpad({ isOpen, onClose, currentApp }: LaunchpadProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [enabledIds, setEnabledIds] = useState<Set<string> | null>(cachedEnabledIds);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener('keydown', handleKeyDown);
    // Refetch on open if cache is stale; otherwise use the cached value
    // (already pushed into local state above).
    const now = Date.now();
    if (!cachedEnabledIds || now - cacheFetchedAt > CACHE_TTL_MS) {
      fetchEnabledAppIds().then((ids) => {
        cachedEnabledIds = ids;
        cacheFetchedAt = Date.now();
        setEnabledIds(ids);
      });
    }
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  // Filter the catalog to enabled ids; if we don't have a list yet (initial
  // load or fetch error), show every app. Always include the currentApp so
  // the user can still see "you are here" even if it was just disabled.
  const visibleApps = enabledIds
    ? APPS.filter((app) => enabledIds.has(app.id) || app.id === currentApp)
    : APPS;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={ref}
        className="relative w-full max-w-2xl bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl p-6 animate-[fade-in_0.15s_ease-out]"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          <X className="h-5 w-5" />
        </button>
        <h2 className="text-lg font-semibold mb-4 text-zinc-900 dark:text-zinc-100">BigBlueBam Suite</h2>
        <div className="grid grid-cols-4 gap-3">
          {visibleApps.map((app) => {
            const Icon = app.icon;
            const isCurrent = app.id === currentApp;
            return (
              <a
                key={app.id}
                href={app.path}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl transition-colors ${
                  isCurrent
                    ? 'bg-primary-50 dark:bg-zinc-800/60 ring-2 ring-primary-400/50 dark:ring-primary-500/40'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                <div
                  className="flex items-center justify-center h-10 w-10 rounded-xl text-white"
                  style={{ backgroundColor: app.color }}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div className="text-center">
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{app.name}</div>
                  <div className="text-[10px] text-zinc-500">{app.description}</div>
                </div>
              </a>
            );
          })}
        </div>
      </div>
    </div>
  );
}
