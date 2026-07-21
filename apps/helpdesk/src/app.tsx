import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { useTenantStore, parseTenantFromPath } from '@/stores/tenant.store';
import { api, ApiError } from '@/lib/api';
import { LoginPage } from '@/pages/login';
import { RegisterPage } from '@/pages/register';
import { VerifyEmailPage } from '@/pages/verify-email';
import { TicketsListPage } from '@/pages/tickets-list';
import { NewTicketPage } from '@/pages/new-ticket';
import { TicketDetailPage } from '@/pages/ticket-detail';
import { OrgPickerPage } from '@/pages/org-picker';
import { Header } from '@/components/layout/header';
import { ImpersonationBanner } from '@bigbluebam/ui/impersonation-banner';
import { NotificationPrompt } from '@/components/notification-prompt';
import { OfflineBanner } from '@/components/offline-banner';
import { ws } from '@/lib/websocket';
import { useBrowserNotifications } from '@/hooks/use-browser-notifications';
import { useMutationRetry } from '@/hooks/use-mutation-retry';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'org-picker' }
  | { page: 'login' }
  | { page: 'register' }
  | { page: 'verify' }
  | { page: 'tickets' }
  | { page: 'new-ticket' }
  | { page: 'ticket-detail'; ticketId: string };

const BASE_PATH = '/helpdesk';

/**
 * Strip `/helpdesk` and the tenant prefix (`/<orgSlug>` and optional
 * `/<projectSlug>`) off the pathname, returning whatever comes after.
 * "`/helpdesk/mage-inc/tickets/42`" -> "/tickets/42".
 * "`/helpdesk/mage-inc/frndo/tickets/42`" -> "/tickets/42".
 */
function stripBaseAndTenant(
  path: string,
  orgSlug: string | null,
  projectSlug: string | null,
): string {
  let p = path;
  if (p.startsWith(BASE_PATH)) p = p.slice(BASE_PATH.length);
  if (!p) return '/';
  // Trim leading slash
  if (p.startsWith('/')) p = p.slice(1);
  const parts = p.split('/');
  if (orgSlug && parts[0] === orgSlug) {
    parts.shift();
    if (projectSlug && parts[0] === projectSlug) {
      parts.shift();
    }
  }
  const rest = parts.join('/');
  return rest ? `/${rest}` : '/';
}

function parseRoute(
  path: string,
  orgSlug: string | null,
  projectSlug: string | null,
): Route {
  // No tenant and at root path -> show org picker.
  if (!orgSlug) {
    // Legacy: `/helpdesk/tickets/...` paths without an org slug still route
    // to the authenticated SPA pages so bookmarks continue to work while
    // the rollout is in progress.
    const legacy = stripBaseAndTenant(path, null, null);
    const ticketMatch = legacy.match(/^\/tickets\/([^/]+)$/);
    if (ticketMatch && ticketMatch[1] !== 'new') {
      return { page: 'ticket-detail', ticketId: ticketMatch[1]! };
    }
    if (legacy === '/tickets/new') return { page: 'new-ticket' };
    if (legacy === '/tickets') return { page: 'tickets' };
    if (legacy === '/register') return { page: 'register' };
    if (legacy === '/verify') return { page: 'verify' };
    if (legacy === '/login') return { page: 'login' };
    return { page: 'org-picker' };
  }

  const p = stripBaseAndTenant(path, orgSlug, projectSlug);
  const ticketMatch = p.match(/^\/tickets\/([^/]+)$/);
  if (ticketMatch && ticketMatch[1] !== 'new') {
    return { page: 'ticket-detail', ticketId: ticketMatch[1]! };
  }
  if (p === '/tickets/new') return { page: 'new-ticket' };
  if (p === '/tickets') return { page: 'tickets' };
  if (p === '/register') return { page: 'register' };
  if (p === '/verify') return { page: 'verify' };
  if (p === '/login') return { page: 'login' };
  return { page: 'tickets' };
}

function buildTenantPath(
  path: string,
  orgSlug: string | null,
  projectSlug: string | null,
): string {
  const tenantSegment =
    orgSlug && projectSlug
      ? `/${orgSlug}/${projectSlug}`
      : orgSlug
        ? `/${orgSlug}`
        : '';
  // path is expected to start with "/"
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_PATH}${tenantSegment}${normalized}`;
}

interface PublicOrgPayload {
  org: { slug: string; name: string; logo_url: string | null };
  settings: {
    welcome_message: string | null;
    categories: unknown;
    require_email_verification: boolean;
    allowed_email_domains: string[];
  };
  projects: Array<{ slug: string; name: string }>;
}

export function App() {
  const { isAuthenticated, isLoading, fetchMe } = useAuthStore();
  const tenantStore = useTenantStore();

  // Initial parse: set slugs before fetchMe fires so the first /auth/me
  // request already carries the X-Org-Slug header.
  const [route, setRoute] = useState<Route>(() => {
    const { orgSlug, projectSlug } = parseTenantFromPath(window.location.pathname);
    useTenantStore.getState().setSlugs(orgSlug, projectSlug);
    return parseRoute(window.location.pathname, orgSlug, projectSlug);
  });

  useBrowserNotifications();
  useMutationRetry();

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  // D-010: Resolve org + project display names once we know the slugs so
  // the header can render org-aware branding. 404 from the server means
  // the slug is bogus; we leave the branding null and the existing header
  // falls back to generic "BigBlueBam Helpdesk".
  useEffect(() => {
    const { orgSlug, projectSlug } = tenantStore;
    if (!orgSlug) {
      tenantStore.setBranding(null, null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ data: PublicOrgPayload }>(
          `/public/orgs/${encodeURIComponent(orgSlug)}`,
        );
        if (cancelled) return;
        const projectName = projectSlug
          ? res.data.projects.find((p) => p.slug === projectSlug)?.name ?? null
          : null;
        tenantStore.setBranding(res.data.org.name, projectName);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          // Unknown slug: leave branding null so header falls back.
          tenantStore.setBranding(null, null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantStore.orgSlug, tenantStore.projectSlug]);

  // Connect WebSocket when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      ws.connect();
      return () => ws.disconnect();
    }
  }, [isAuthenticated]);

  useEffect(() => {
    const handlePopState = () => {
      const { orgSlug, projectSlug } = parseTenantFromPath(window.location.pathname);
      useTenantStore.getState().setSlugs(orgSlug, projectSlug);
      setRoute(parseRoute(window.location.pathname, orgSlug, projectSlug));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback(
    (path: string) => {
      const { orgSlug, projectSlug } = useTenantStore.getState();
      const fullPath = buildTenantPath(path, orgSlug, projectSlug);
      window.history.pushState(null, '', fullPath);
      setRoute(parseRoute(fullPath, orgSlug, projectSlug));
    },
    [],
  );

  // ? keyboard shortcut to open Help
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === '?' && !isInInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        openHelpCenter('helpdesk');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-primary-600 text-white font-bold text-2xl">
            B
          </div>
          <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
        </div>
      </div>
    );
  }

  // D-010: org picker when we have no org slug at all.
  if (route.page === 'org-picker') {
    return <OrgPickerPage />;
  }

  // Verify email page is accessible without auth
  if (route.page === 'verify') {
    return <VerifyEmailPage onNavigate={navigate} />;
  }

  if (!isAuthenticated) {
    if (route.page === 'register') {
      return <RegisterPage onNavigate={navigate} />;
    }
    return <LoginPage onNavigate={navigate} />;
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <ImpersonationBanner />
      <OfflineBanner />
      <Header onNavigate={navigate} />
      <main className="max-w-5xl mx-auto px-4 py-8">
        {(() => {
          switch (route.page) {
            case 'new-ticket':
              return <NewTicketPage onNavigate={navigate} />;
            case 'ticket-detail':
              return <TicketDetailPage ticketId={route.ticketId} onNavigate={navigate} />;
            case 'tickets':
            default:
              return (
                <>
                  <NotificationPrompt />
                  <TicketsListPage onNavigate={navigate} />
                </>
              );
          }
        })()}
      </main>
    </div>
  );
}
