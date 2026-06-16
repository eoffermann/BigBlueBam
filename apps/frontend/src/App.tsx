import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { LoginPage } from '@/pages/login';
import { RegisterPage } from '@/pages/register';
import { DashboardPage } from '@/pages/dashboard';
import { BoardPage } from '@/pages/board';
import { SettingsPage } from '@/pages/settings';
import { MyWorkPage } from '@/pages/my-work';
import { ProjectDashboardPage } from '@/pages/project-dashboard';
import { EpicDetailPage } from '@/pages/epic-detail';
import { AuditLogPage } from '@/pages/audit-log';
import { SprintReportPage } from '@/pages/sprint-report';
import { ProjectReportsPage } from '@/pages/project-reports';
import { SuperuserPage } from '@/pages/superuser';
// The SuperUser people LIST was retired in favor of /people-manager (the legacy
// URL is redirected below). The DETAIL page stays live: it still hosts
// SuperUser-only powers (impersonate, grant/revoke SuperUser, session
// inventory, change email, arbitrary cross-org membership) not yet in People
// Manager, reachable via the "SuperUser tools" link on the People Manager
// detail page.
import { SuperuserPeopleDetailPage } from '@/pages/superuser/people-detail';
import { SuperuserAgentsListPage } from '@/pages/superuser/agents-list';
import { PlatformCallingSettingsPage } from '@/pages/superuser/platform-calling-settings';
import { PermissionsGroupDetailPage } from '@/pages/superuser/permissions/group-detail';
import { Shield, ArrowLeft } from 'lucide-react';
import { PeoplePage } from '@/pages/people';
import { PersonDetailPage } from '@/pages/people/detail';
import { PeopleManagerPage } from '@/pages/people-manager';
import { PeopleManagerDetailPage } from '@/pages/people-manager/detail';
import { GuestAcceptPage } from '@/pages/guest-accept';
import { PasswordChangePage } from '@/pages/password-change';
import { PasswordResetPage } from '@/pages/password-reset';
import { TaskRefResolverPage } from '@/pages/task-ref-resolver';
import { BetaGatePage } from '@/pages/beta-gate';
import { BetaNotifyPage } from '@/pages/beta-notify';
import { SuperuserBootstrapPage } from '@/pages/superuser-bootstrap';
import { usePublicConfig } from '@/hooks/use-public-config';
import { HelpdeskAgentQueuePage } from '@/pages/helpdesk-agent-queue';
import { HelpViewer } from '@bigbluebam/ui/help-viewer';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'login' }
  | { page: 'register' }
  | { page: 'password-change' }
  | { page: 'password-reset'; token: string | null }
  | { page: 'dashboard' }
  | { page: 'board'; projectId: string }
  | { page: 'epic-detail'; projectId: string; epicId: string }
  | { page: 'project-dashboard'; projectId: string }
  | { page: 'audit-log'; projectId: string }
  | { page: 'sprint-report'; projectId: string; sprintId: string }
  | { page: 'project-reports'; projectId: string }
  | { page: 'settings' }
  | { page: 'my-work' }
  | { page: 'superuser' }
  | { page: 'superuser-person-detail'; userId: string }
  | { page: 'superuser-agents' }
  | { page: 'superuser-platform-calling' }
  | { page: 'superuser-permissions-group-detail'; groupId: string }
  | { page: 'people' }
  | { page: 'person-detail'; userId: string }
  | { page: 'people-manager' }
  | { page: 'people-manager-detail'; userId: string }
  | { page: 'guest-accept'; token: string }
  | { page: 'task-ref'; ref: string }
  | { page: 'helpdesk-queue' }
  | { page: 'beta-gate' }
  | { page: 'beta-notify' }
  | { page: 'bootstrap' }
  | { page: 'help' };

const BASE_PATH = '/b3';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);
  const guestAcceptMatch = p.match(/^\/guests\/accept\/(.+)$/);
  if (guestAcceptMatch) {
    return { page: 'guest-accept', token: guestAcceptMatch[1]! };
  }
  const taskRefMatch = p.match(/^\/tasks\/ref\/([^/]+)$/);
  if (taskRefMatch) {
    return { page: 'task-ref', ref: decodeURIComponent(taskRefMatch[1]!) };
  }
  const boardMatch = p.match(/^\/projects\/([^/]+)\/board$/);
  if (boardMatch) {
    return { page: 'board', projectId: boardMatch[1]! };
  }
  const epicDetailMatch = p.match(/^\/projects\/([^/]+)\/epics\/([^/]+)$/);
  if (epicDetailMatch) {
    return { page: 'epic-detail', projectId: epicDetailMatch[1]!, epicId: epicDetailMatch[2]! };
  }
  const dashboardMatch = p.match(/^\/projects\/([^/]+)\/dashboard$/);
  if (dashboardMatch) {
    return { page: 'project-dashboard', projectId: dashboardMatch[1]! };
  }
  const auditMatch = p.match(/^\/projects\/([^/]+)\/audit-log$/);
  if (auditMatch) {
    return { page: 'audit-log', projectId: auditMatch[1]! };
  }
  const projectReportsMatch = p.match(/^\/projects\/([^/]+)\/reports$/);
  if (projectReportsMatch) {
    return { page: 'project-reports', projectId: projectReportsMatch[1]! };
  }
  const sprintReportMatch = p.match(/^\/projects\/([^/]+)\/sprints\/([^/]+)\/report$/);
  if (sprintReportMatch) {
    return { page: 'sprint-report', projectId: sprintReportMatch[1]!, sprintId: sprintReportMatch[2]! };
  }
  const superuserPersonMatch = p.match(/^\/superuser\/people\/([^/]+)$/);
  if (superuserPersonMatch) {
    return { page: 'superuser-person-detail', userId: superuserPersonMatch[1]! };
  }
  // The SuperUser people LIST is retired; route the legacy path straight to the
  // unified People Manager (the URL is canonicalized via replaceState below).
  if (p === '/superuser/people' || p === '/superuser/people/') {
    return { page: 'people-manager' };
  }
  if (p === '/superuser/agents' || p === '/superuser/agents/') {
    return { page: 'superuser-agents' };
  }
  if (p === '/superuser/platform-calling' || p === '/superuser/platform-calling/') {
    return { page: 'superuser-platform-calling' };
  }
  const superuserPermGroupMatch = p.match(/^\/superuser\/permissions\/groups\/([^/]+)$/);
  if (superuserPermGroupMatch) {
    return { page: 'superuser-permissions-group-detail', groupId: superuserPermGroupMatch[1]! };
  }
  const peopleManagerDetailMatch = p.match(/^\/people-manager\/([^/]+)$/);
  if (peopleManagerDetailMatch) {
    return { page: 'people-manager-detail', userId: peopleManagerDetailMatch[1]! };
  }
  if (p === '/people-manager' || p === '/people-manager/') {
    return { page: 'people-manager' };
  }
  const personDetailMatch = p.match(/^\/people\/([^/]+)$/);
  if (personDetailMatch) {
    return { page: 'person-detail', userId: personDetailMatch[1]! };
  }
  if (p === '/people' || p === '/people/') return { page: 'people' };
  if (p === '/helpdesk-queue') return { page: 'helpdesk-queue' };
  if (p === '/help') return { page: 'help' };
  if (p === '/register') return { page: 'register' };
  if (p === '/bootstrap') return { page: 'bootstrap' };
  if (p === '/beta-gate') return { page: 'beta-gate' };
  if (p === '/notify') return { page: 'beta-notify' };
  if (p === '/login') return { page: 'login' };
  if (p === '/password-change') return { page: 'password-change' };
  if (p === '/password-reset' || p === '/password-reset/') {
    const params = new URLSearchParams(window.location.search);
    return { page: 'password-reset', token: params.get('token') };
  }
  if (p === '/settings') return { page: 'settings' };
  if (p === '/my-work') return { page: 'my-work' };
  if (p === '/superuser') return { page: 'superuser' };
  return { page: 'dashboard' };
}

export function App() {
  const { isAuthenticated, isLoading, fetchMe, user } = useAuthStore();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const publicConfig = usePublicConfig();

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  useEffect(() => {
    // Apply saved theme on mount
    const savedTheme = localStorage.getItem('bbam-theme') ?? 'system';
    const root = document.documentElement;
    root.classList.remove('dark'); // Start clean
    if (savedTheme === 'dark') {
      root.classList.add('dark');
    } else if (savedTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.classList.add('dark');
    }
    // 'light' = no dark class (already removed above)
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Canonicalize the retired SuperUser people LIST path to /people-manager.
  // parseRoute already renders People Manager for the legacy URL; this rewrites
  // the address bar (replaceState, so Back doesn't bounce through the old path).
  useEffect(() => {
    const stripped = stripBase(window.location.pathname);
    if (stripped === '/superuser/people' || stripped === '/superuser/people/') {
      window.history.replaceState(null, '', `${BASE_PATH}/people-manager`);
    }
  }, [route]);

  const navigate = useCallback((path: string) => {
    const fullPath = `${BASE_PATH}${path}`;
    window.history.pushState(null, '', fullPath);
    // Strip the query string (and any hash) before parsing — the route
    // matchers below use `$`-anchored regexes that don't expect a
    // trailing `?task=<id>` etc. The query string stays in the URL for
    // the destination page to read via window.location.search.
    const pathnameOnly = fullPath.split('?')[0]!.split('#')[0]!;
    setRoute(parseRoute(pathnameOnly));
  }, []);

  // ? keyboard shortcut to open Help
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;
      if (e.key === '?' && !isInInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        navigate('/help');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  // Bootstrap gate: when the install has no real SuperUser yet, force the
  // unauthenticated visitor onto the bootstrap page regardless of what they
  // typed. The gate is skipped for authenticated users so a fresh bootstrap
  // submit (which logs in and leaves publicConfig temporarily stale) does
  // not bounce the new SuperUser back onto the form they just completed.
  useEffect(() => {
    if (isLoading || publicConfig.isLoading || !publicConfig.data) return;
    if (isAuthenticated) return;
    if (publicConfig.data.bootstrap_required) {
      if (route.page !== 'bootstrap') {
        navigate('/bootstrap');
      }
    } else if (route.page === 'bootstrap') {
      navigate('/');
    }
  }, [isLoading, isAuthenticated, publicConfig.isLoading, publicConfig.data, route.page, navigate]);

  // Force-password-change gate: if the server has flagged this user, block
  // every page except the password-change form (and the public auth pages).
  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated || !user) return;
    if (user.force_password_change !== true) return;
    if (
      route.page === 'password-change' ||
      route.page === 'login' ||
      route.page === 'register'
    ) {
      return;
    }
    navigate('/password-change');
  }, [isLoading, isAuthenticated, user, route.page, navigate]);

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

  // Guest-accept is public — it works whether or not the user is logged in.
  // (The page itself will warn an already-signed-in user.)
  if (route.page === 'guest-accept') {
    return <GuestAcceptPage token={route.token} onNavigate={navigate} />;
  }

  // Password-reset link consumption is public — the user is anonymous when
  // they click the email link and is signed out (every session is deleted)
  // on success. The page handles its own redirect to /login afterwards.
  if (route.page === 'password-reset') {
    return <PasswordResetPage token={route.token} onNavigate={navigate} />;
  }

  // Beta-gate + notify-me are public marketing-ish surfaces reachable from
  // the login page when public signup is disabled.
  if (route.page === 'beta-gate') {
    return <BetaGatePage onNavigate={navigate} />;
  }
  if (route.page === 'beta-notify') {
    return <BetaNotifyPage onNavigate={navigate} />;
  }
  // SuperUser bootstrap: first-run page when no real SuperUser exists yet.
  // Public because there is no account to authenticate against at that point.
  // An already-authenticated user hitting /b3/bootstrap falls through to the
  // normal routing below — the endpoint would reject them with 409 anyway.
  if (route.page === 'bootstrap' && !isAuthenticated) {
    return <SuperuserBootstrapPage onNavigate={navigate} />;
  }

  if (!isAuthenticated) {
    if (route.page === 'register') {
      return <RegisterPage onNavigate={navigate} />;
    }
    return <LoginPage onNavigate={navigate} />;
  }

  // Authenticated but must change password first — render only the
  // password-change form, no layout, no other pages reachable.
  if (user?.force_password_change === true && route.page !== 'password-change') {
    return <PasswordChangePage onNavigate={navigate} />;
  }

  if (route.page === 'password-change') {
    return <PasswordChangePage onNavigate={navigate} />;
  }

  switch (route.page) {
    case 'board':
      return <BoardPage projectId={route.projectId} onNavigate={navigate} />;
    case 'epic-detail':
      return <EpicDetailPage projectId={route.projectId} epicId={route.epicId} onNavigate={navigate} />;
    case 'project-dashboard':
      return <ProjectDashboardPage projectId={route.projectId} onNavigate={navigate} />;
    case 'audit-log':
      return <AuditLogPage projectId={route.projectId} onNavigate={navigate} />;
    case 'sprint-report':
      return <SprintReportPage projectId={route.projectId} sprintId={route.sprintId} onNavigate={navigate} />;
    case 'project-reports':
      return <ProjectReportsPage projectId={route.projectId} onNavigate={navigate} />;
    case 'settings':
      return <SettingsPage onNavigate={navigate} />;
    case 'my-work':
      return <MyWorkPage onNavigate={navigate} />;
    case 'superuser':
      return <SuperuserPage onNavigate={navigate} />;
    case 'superuser-person-detail':
      return <SuperuserPeopleDetailPage userId={route.userId} onNavigate={navigate} />;
    case 'superuser-agents':
      return <SuperuserAgentsListPage onNavigate={navigate} />;
    case 'superuser-platform-calling':
      return <PlatformCallingSettingsPage onNavigate={navigate} />;
    case 'superuser-permissions-group-detail':
      return (
        <SuperuserPermissionsGroupDetailLayout groupId={route.groupId} onNavigate={navigate} />
      );
    case 'people':
      return <PeoplePage onNavigate={navigate} />;
    case 'person-detail':
      return <PersonDetailPage userId={route.userId} onNavigate={navigate} />;
    case 'people-manager':
      return <PeopleManagerPage onNavigate={navigate} />;
    case 'people-manager-detail':
      return <PeopleManagerDetailPage userId={route.userId} onNavigate={navigate} />;
    case 'helpdesk-queue':
      return <HelpdeskAgentQueuePage onNavigate={navigate} />;
    case 'task-ref':
      return <TaskRefResolverPage ref={route.ref} onNavigate={navigate} />;
    case 'help':
      return <HelpViewer appSlug="bam" onBack={() => navigate('/')} />;
    case 'login':
    case 'register':
    case 'dashboard':
    default:
      return <DashboardPage onNavigate={navigate} />;
  }
}

// ─── SuperUser permissions group detail layout ──────────────────────────────
// Wraps PermissionsGroupDetailPage in the standard SuperUser console chrome
// (back-button + SU badge header). Inline here rather than in a dedicated
// page file because the page itself can be reused from anywhere.
function SuperuserPermissionsGroupDetailLayout({
  groupId,
  onNavigate,
}: {
  groupId: string;
  onNavigate: (path: string) => void;
}) {
  const { user } = useAuthStore();
  useEffect(() => {
    if (user && user.is_superuser !== true) onNavigate('/');
  }, [user, onNavigate]);

  if (!user || user.is_superuser !== true) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-3">
          <button
            onClick={() => onNavigate('/superuser')}
            className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            title="Back to SuperUser Console"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-red-100 dark:bg-red-900/30">
            <Shield className="h-4.5 w-4.5 text-red-600 dark:text-red-400" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Permission group
            </h1>
            <p className="text-xs text-zinc-500">Edit per-permission defaults</p>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-6">
        <PermissionsGroupDetailPage groupId={groupId} onNavigate={onNavigate} />
      </main>
    </div>
  );
}
