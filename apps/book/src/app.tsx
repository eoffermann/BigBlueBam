import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BookLayout } from '@/components/layout/book-layout';
import { CalendarWeekPage } from '@/pages/calendar-week';
import { CalendarDayPage } from '@/pages/calendar-day';
import { CalendarMonthPage } from '@/pages/calendar-month';
import { TimelinePage } from '@/pages/timeline';
import { EventDetailPage } from '@/pages/event-detail';
import { EventFormPage } from '@/pages/event-form';
import { BookingPageListPage } from '@/pages/booking-page-list';
import { BookingPageEditorPage } from '@/pages/booking-page-editor';
import { WorkingHoursPage } from '@/pages/working-hours';
import { ConnectionsPage } from '@/pages/connections';
import { CalendarsPage } from '@/pages/calendars';
import { MeetPage } from '@/pages/meet';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'week' }
  | { page: 'day'; date?: string }
  | { page: 'month'; month?: string }
  | { page: 'timeline' }
  | { page: 'event-detail'; id: string }
  | { page: 'event-new' }
  | { page: 'event-edit'; id: string }
  | { page: 'booking-pages' }
  | { page: 'booking-page-edit'; id: string }
  | { page: 'working-hours' }
  | { page: 'connections' }
  | { page: 'calendars' }
  | { page: 'meet'; slug: string };

const BASE_PATH = '/book';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  if (p === '/' || p === '') return { page: 'week' };
  if (p === '/day') return { page: 'day' };
  if (p === '/timeline') return { page: 'timeline' };
  if (p === '/booking-pages') return { page: 'booking-pages' };

  // /meet/:slug — public booking page (no auth required)
  const meetMatch = p.match(/^\/meet\/([^/]+)$/);
  if (meetMatch) return { page: 'meet', slug: meetMatch[1]! };
  if (p === '/settings/working-hours') return { page: 'working-hours' };
  if (p === '/settings/connections') return { page: 'connections' };
  if (p === '/settings/calendars') return { page: 'calendars' };

  const dayMatch = p.match(/^\/day\/(\d{4}-\d{2}-\d{2})$/);
  if (dayMatch) return { page: 'day', date: dayMatch[1]! };

  const monthMatch = p.match(/^\/month(?:\/(\d{4}-\d{2}))?$/);
  if (monthMatch) return { page: 'month', month: monthMatch[1] };

  if (p === '/events/new') return { page: 'event-new' };

  const eventEditMatch = p.match(/^\/events\/([^/]+)\/edit$/);
  if (eventEditMatch) return { page: 'event-edit', id: eventEditMatch[1]! };

  const eventMatch = p.match(/^\/events\/([^/]+)$/);
  if (eventMatch) return { page: 'event-detail', id: eventMatch[1]! };

  const bookingEditMatch = p.match(/^\/booking-pages\/([^/]+)\/edit$/);
  if (bookingEditMatch) return { page: 'booking-page-edit', id: bookingEditMatch[1]! };

  return { page: 'week' };
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

  // Public booking page bypasses auth so anonymous visitors can book.
  if (route.page === 'meet') {
    return <MeetPage slug={route.slug} />;
  }

  // ? keyboard shortcut to open Help
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === '?' && !isInInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        openHelpCenter('book');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-blue-600 text-white font-bold text-2xl">
            B
          </div>
          <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-100">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">Book Scheduling & Calendar</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Book.</p>
          <a href="/b3/" className="inline-block px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  const renderPage = () => {
    switch (route.page) {
      case 'week':
        return <CalendarWeekPage onNavigate={navigate} />;
      case 'day':
        return <CalendarDayPage onNavigate={navigate} date={(route as any).date} />;
      case 'month':
        return <CalendarMonthPage onNavigate={navigate} month={(route as any).month} />;
      case 'timeline':
        return <TimelinePage onNavigate={navigate} />;
      case 'event-detail':
        return <EventDetailPage eventId={route.id} onNavigate={navigate} />;
      case 'event-new':
        return <EventFormPage onNavigate={navigate} />;
      case 'event-edit':
        return <EventFormPage eventId={route.id} onNavigate={navigate} />;
      case 'booking-pages':
        return <BookingPageListPage onNavigate={navigate} />;
      case 'booking-page-edit':
        return <BookingPageEditorPage bookingPageId={route.id} onNavigate={navigate} />;
      case 'working-hours':
        return <WorkingHoursPage onNavigate={navigate} />;
      case 'connections':
        return <ConnectionsPage onNavigate={navigate} />;
      case 'calendars':
        return <CalendarsPage onNavigate={navigate} />;
      // 'meet' handled by the early-return branch above so it never reaches
      // here. The type narrowing at the early return excludes it from the
      // switch's discriminated union.
      default:
        return null;
    }
  };

  return (
    <BookLayout onNavigate={navigate} activeRoute={route}>
      {renderPage()}
    </BookLayout>
  );
}
