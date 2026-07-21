import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BillLayout } from '@/components/layout/bill-layout';
import { DashboardPage } from '@/pages/dashboard';
import { InvoiceListPage } from '@/pages/invoice-list';
import { InvoiceNewPage } from '@/pages/invoice-new';
import { InvoiceFromTimePage } from '@/pages/invoice-from-time';
import { InvoiceDetailPage } from '@/pages/invoice-detail';
import { InvoiceEditPage } from '@/pages/invoice-edit';
import { RecurringListPage } from '@/pages/recurring-list';
import { ClientListPage } from '@/pages/client-list';
import { ClientDetailPage } from '@/pages/client-detail';
import { ExpenseListPage } from '@/pages/expense-list';
import { ExpenseNewPage } from '@/pages/expense-new';
import { RateListPage } from '@/pages/rate-list';
import { ReportsPage } from '@/pages/reports';
import { SettingsPage } from '@/pages/settings';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'dashboard' }
  | { page: 'invoices' }
  | { page: 'invoice-new' }
  | { page: 'invoice-from-time' }
  | { page: 'invoice-detail'; id: string }
  | { page: 'invoice-edit'; id: string }
  | { page: 'recurring' }
  | { page: 'clients' }
  | { page: 'client-detail'; id: string }
  | { page: 'expenses' }
  | { page: 'expense-new' }
  | { page: 'rates' }
  | { page: 'reports' }
  | { page: 'settings' };

const BASE_PATH = '/bill';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  // Strip any query string / hash before matching — pages read it separately
  // (e.g. the invoice list reads ?status=overdue from window.location.search).
  const p = stripBase(path).split('?')[0]!.split('#')[0]!;

  if (p === '/' || p === '') return { page: 'dashboard' };
  if (p === '/invoices') return { page: 'invoices' };
  if (p === '/invoices/new') return { page: 'invoice-new' };
  if (p === '/invoices/from-time') return { page: 'invoice-from-time' };
  if (p === '/recurring') return { page: 'recurring' };
  if (p === '/clients') return { page: 'clients' };
  if (p === '/expenses') return { page: 'expenses' };
  if (p === '/expenses/new') return { page: 'expense-new' };
  if (p === '/rates') return { page: 'rates' };
  if (p === '/reports') return { page: 'reports' };
  if (p === '/settings') return { page: 'settings' };

  const invoiceEditMatch = p.match(/^\/invoices\/([^/]+)\/edit$/);
  if (invoiceEditMatch) return { page: 'invoice-edit', id: invoiceEditMatch[1]! };

  const invoiceDetailMatch = p.match(/^\/invoices\/([^/]+)$/);
  if (invoiceDetailMatch) return { page: 'invoice-detail', id: invoiceDetailMatch[1]! };

  const clientDetailMatch = p.match(/^\/clients\/([^/]+)$/);
  if (clientDetailMatch) return { page: 'client-detail', id: clientDetailMatch[1]! };

  return { page: 'dashboard' };
}

export function App() {
  const { isAuthenticated, isLoading, fetchMe } = useAuthStore();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  useEffect(() => {
    const savedTheme = localStorage.getItem('bbam-theme') ?? 'system';
    const root = document.documentElement;
    root.classList.remove('dark');
    if (savedTheme === 'dark') {
      root.classList.add('dark');
    } else if (savedTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.classList.add('dark');
    }
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((path: string) => {
    const fullPath = `${BASE_PATH}${path}`;
    window.history.pushState(null, '', fullPath);
    setRoute(parseRoute(fullPath));
  }, []);

  // ? keyboard shortcut to open Help
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === '?' && !isInInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        openHelpCenter('bill');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-green-600 text-white font-bold text-2xl">
            $
          </div>
          <Loader2 className="h-6 w-6 animate-spin text-green-500" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-100">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">Bill Invoicing & Billing</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Bill.</p>
          <a href="/b3/" className="inline-block px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  const renderPage = () => {
    switch (route.page) {
      case 'dashboard':
        return <DashboardPage onNavigate={navigate} />;
      case 'invoices':
        return <InvoiceListPage onNavigate={navigate} />;
      case 'invoice-new':
        return <InvoiceNewPage onNavigate={navigate} />;
      case 'invoice-from-time':
        return <InvoiceFromTimePage onNavigate={navigate} />;
      case 'invoice-detail':
        return <InvoiceDetailPage invoiceId={(route as any).id} onNavigate={navigate} />;
      case 'invoice-edit':
        return <InvoiceEditPage invoiceId={(route as any).id} onNavigate={navigate} />;
      case 'recurring':
        return <RecurringListPage onNavigate={navigate} />;
      case 'clients':
        return <ClientListPage onNavigate={navigate} />;
      case 'client-detail':
        return <ClientDetailPage clientId={(route as any).id} onNavigate={navigate} />;
      case 'expenses':
        return <ExpenseListPage onNavigate={navigate} />;
      case 'expense-new':
        return <ExpenseNewPage onNavigate={navigate} />;
      case 'rates':
        return <RateListPage onNavigate={navigate} />;
      case 'reports':
        return <ReportsPage onNavigate={navigate} />;
      case 'settings':
        return <SettingsPage onNavigate={navigate} />;
      default:
        return null;
    }
  };

  return (
    <BillLayout onNavigate={navigate} activeRoute={route}>
      {renderPage()}
    </BillLayout>
  );
}
