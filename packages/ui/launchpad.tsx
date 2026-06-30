/**
 * Canonical Launchpad component — shared across all BigBlueBam apps.
 *
 * Every frontend app imports this file via a Vite alias:
 *   '@bigbluebam/ui/launchpad' → '<root>/packages/ui/launchpad.tsx'
 *
 * As of 2026-06-09 the apps list is fetched at runtime from
 * `/b3/api/launchpad/apps` (catalog_detail field). Each SPA only needs to
 * carry the icon-name → component map below. Adding a new app to the
 * suite no longer requires rebuilding every SPA — the next page load
 * picks it up automatically as long as the icon name is one we already
 * import here. If the new app needs a brand-new icon, add it to ICONS
 * below and rebuild the SPAs once.
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
  Building,
  Database,
  Clapperboard,
  Activity,
  Box,
  type LucideIcon,
} from 'lucide-react';

interface AppEntry {
  id: string;
  name: string;
  description: string;
  icon_name: string;
  color: string;
  path: string;
}

interface LaunchpadResponse {
  data?: {
    catalog?: string[];
    catalog_detail?: AppEntry[];
    enabled?: string[];
  };
}

// Icon-name → lucide component map. The server emits icon names in
// kebab-case to keep the catalog string-friendly; this map resolves them
// to the actual React component. Unknown names fall back to <Box />.
const ICONS: Record<string, LucideIcon> = {
  'layout-dashboard': LayoutDashboard,
  'message-circle': MessageCircle,
  'book-open': BookOpen,
  'file-text': FileText,
  zap: Zap,
  target: Target,
  'pen-tool': PenTool,
  headset: Headset,
  handshake: Handshake,
  mail: Mail,
  'bar-chart-3': BarChart3,
  calendar: Calendar,
  'clipboard-list': ClipboardList,
  'dollar-sign': DollarSign,
  sparkles: Sparkles,
  building: Building,
  database: Database,
  clapperboard: Clapperboard,
  activity: Activity,
};

// Hard-coded fallback used ONLY when the API is unreachable on the very
// first load. Kept minimal so the suite still renders a usable Launchpad
// in degraded mode; the runtime API is the source of truth.
const FALLBACK_APPS: AppEntry[] = [
  { id: 'b3', name: 'Bam', description: 'Project Management', icon_name: 'layout-dashboard', color: '#2563eb', path: '/b3/' },
  { id: 'helpdesk', name: 'Helpdesk', description: 'Customer Support', icon_name: 'headset', color: '#be123c', path: '/helpdesk/' },
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
    data-ftue="launchpad"
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

interface LaunchpadCache {
  catalog: AppEntry[];
  enabledIds: Set<string> | null;
  fetchedAt: number;
}

let cache: LaunchpadCache | null = null;
const CACHE_TTL_MS = 60_000;

async function fetchCatalog(): Promise<LaunchpadCache | null> {
  try {
    const res = await fetch('/b3/api/launchpad/apps', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as LaunchpadResponse;
    const catalog = Array.isArray(json.data?.catalog_detail)
      ? (json.data!.catalog_detail!.filter(
          (e): e is AppEntry =>
            !!e &&
            typeof e.id === 'string' &&
            typeof e.name === 'string' &&
            typeof e.icon_name === 'string' &&
            typeof e.color === 'string' &&
            typeof e.path === 'string',
        ))
      : [];
    if (catalog.length === 0) return null;
    const enabled = Array.isArray(json.data?.enabled)
      ? new Set(json.data!.enabled!.filter((x): x is string => typeof x === 'string'))
      : null;
    return { catalog, enabledIds: enabled, fetchedAt: Date.now() };
  } catch {
    return null;
  }
}

export function Launchpad({ isOpen, onClose, currentApp }: LaunchpadProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LaunchpadCache | null>(cache);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener('keydown', handleKeyDown);
    const now = Date.now();
    if (!cache || now - cache.fetchedAt > CACHE_TTL_MS) {
      fetchCatalog().then((next) => {
        cache = next;
        setState(next);
      });
    }
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  // Resolve the apps list. Prefer the live catalog; fall back to the
  // minimal hard-coded list if the API is unreachable on first open. The
  // currentApp id is always shown so the user can see "you are here".
  const catalog = state?.catalog ?? FALLBACK_APPS;
  // Always present the apps alphabetically by display name, regardless of the
  // catalog/enabled order returned by the API.
  const visibleApps = (
    state?.enabledIds
      ? catalog.filter((app) => state.enabledIds!.has(app.id) || app.id === currentApp)
      : [...catalog]
  ).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={ref}
        className="relative w-full max-w-2xl bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl p-6 animate-[fade-in_0.15s_ease-out]"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          aria-label="Close launchpad"
        >
          <X className="h-5 w-5" />
        </button>
        <h2 className="text-lg font-semibold mb-4 text-zinc-900 dark:text-zinc-100">
          BigBlueBam Suite
        </h2>
        <div className="grid grid-cols-4 gap-3">
          {visibleApps.map((app) => {
            const Icon = ICONS[app.icon_name] ?? Box;
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
                  <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {app.name}
                  </div>
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
