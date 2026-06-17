import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, GanttChart, Calendar, CheckSquare, Handshake, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn, format, addWeeks, startOfWeek, endOfWeek, isSameDay } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TimelineItem {
  id: string;
  // Source labels match timeline.service.ts: 'book', 'bam_task', 'bam_sprint',
  // 'bearing_goal', 'bond_deal'. SOURCE_CONFIG keys on the same strings.
  source: string;
  title: string;
  start_at: string;      // ISO date/datetime
  end_at?: string | null; // optional end (events)
  subtitle?: string;
  url?: string;          // deep-link
  color?: string;
  metadata?: Record<string, unknown>;
}

interface TimelineResponse {
  data: TimelineItem[];
}

// ---------------------------------------------------------------------------
// Source styling
// ---------------------------------------------------------------------------

const SOURCE_CONFIG: Record<string, { icon: typeof Calendar; label: string; color: string; bgColor: string }> = {
  book: {
    icon: Calendar,
    label: 'Event',
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800',
  },
  bam_task: {
    icon: CheckSquare,
    label: 'Task',
    color: 'text-orange-600 dark:text-orange-400',
    bgColor: 'bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-800',
  },
  bam_sprint: {
    icon: CheckSquare,
    label: 'Sprint',
    color: 'text-orange-600 dark:text-orange-400',
    bgColor: 'bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-800',
  },
  bond_deal: {
    icon: Handshake,
    label: 'Deal',
    color: 'text-teal-600 dark:text-teal-400',
    bgColor: 'bg-teal-50 dark:bg-teal-950/30 border-teal-200 dark:border-teal-800',
  },
  bearing_goal: {
    icon: GanttChart,
    label: 'Goal',
    color: 'text-purple-600 dark:text-purple-400',
    bgColor: 'bg-purple-50 dark:bg-purple-950/30 border-purple-200 dark:border-purple-800',
  },
};

function fallbackSourceConfig() {
  return {
    icon: Calendar,
    label: 'Item',
    color: 'text-zinc-600 dark:text-zinc-400',
    bgColor: 'bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700',
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface TimelinePageProps {
  onNavigate: (path: string) => void;
}

export function TimelinePage({ onNavigate }: TimelinePageProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 0 });
  const weekEnd = endOfWeek(currentDate, { weekStartsOn: 0 });

  // Fetch unified timeline. The GET /v1/timeline route validates
  // start_date / end_date as full ISO datetimes (see timeline.routes.ts).
  const startDate = weekStart.toISOString();
  const endDate = new Date(weekEnd.getTime() + 86400000).toISOString();

  const { data, isLoading } = useQuery({
    queryKey: ['book', 'timeline', startDate, endDate],
    queryFn: () =>
      api.get<TimelineResponse>('/v1/timeline', {
        start_date: startDate,
        end_date: endDate,
      }),
    staleTime: 15_000,
  });

  const items = data?.data ?? [];

  // Group items by day
  const grouped = useMemo(() => {
    const map = new Map<string, TimelineItem[]>();
    for (const item of items) {
      const dayKey = item.start_at.slice(0, 10); // YYYY-MM-DD
      const arr = map.get(dayKey) ?? [];
      arr.push(item);
      map.set(dayKey, arr);
    }
    // Sort day keys chronologically
    const sorted = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    return sorted;
  }, [items]);

  // Generate 7 day keys for the header
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(new Date(weekStart.getTime() + i * 86400000));
  }

  function handleItemClick(item: TimelineItem) {
    if (item.url) {
      // If it points to another app, navigate via href
      if (item.url.startsWith('/book/')) {
        onNavigate(item.url.replace('/book', ''));
      } else {
        window.location.href = item.url;
      }
    } else if (item.source === 'book') {
      onNavigate(`/events/${item.id}/edit`);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-3">
          <GanttChart className="h-5 w-5 text-blue-600" />
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Timeline: {format(weekStart, 'MMM d')} - {format(weekEnd, 'MMM d, yyyy')}
          </h2>
          <div className="flex gap-1">
            <button
              onClick={() => setCurrentDate((d) => addWeeks(d, -1))}
              className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => setCurrentDate(new Date())}
              className="px-3 py-1 text-xs font-medium rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              This Week
            </button>
            <button
              onClick={() => setCurrentDate((d) => addWeeks(d, 1))}
              className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Timeline content */}
      <div className="flex-1 overflow-auto p-6">
        {isLoading && (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
          </div>
        )}

        {!isLoading && items.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-zinc-400 text-sm">
            <Calendar className="h-10 w-10 text-zinc-300 dark:text-zinc-600 mb-3" />
            No items this week
          </div>
        )}

        {!isLoading && grouped.length > 0 && (
          <div className="space-y-6">
            {grouped.map(([dayKey, dayItems]) => {
              const dayDate = new Date(dayKey + 'T00:00:00');
              const isToday = isSameDay(dayDate, new Date());

              return (
                <div key={dayKey}>
                  {/* Day header */}
                  <div className="flex items-center gap-3 mb-3">
                    <div
                      className={cn(
                        'flex items-center justify-center h-8 w-8 rounded-full text-sm font-bold',
                        isToday
                          ? 'bg-blue-600 text-white'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300',
                      )}
                    >
                      {dayDate.getDate()}
                    </div>
                    <div>
                      <span className={cn(
                        'text-sm font-semibold',
                        isToday ? 'text-blue-600' : 'text-zinc-700 dark:text-zinc-300',
                      )}>
                        {format(dayDate, 'EEEE')}
                      </span>
                      <span className="text-xs text-zinc-400 ml-2">{format(dayDate, 'MMM d, yyyy')}</span>
                    </div>
                    <span className="text-xs text-zinc-400">
                      {dayItems.length} item{dayItems.length !== 1 ? 's' : ''}
                    </span>
                  </div>

                  {/* Day items */}
                  <div className="ml-4 border-l-2 border-zinc-200 dark:border-zinc-700 pl-6 space-y-2">
                    {dayItems.map((item) => {
                      const cfg = SOURCE_CONFIG[item.source] ?? fallbackSourceConfig();
                      const Icon = cfg.icon;
                      const time = item.start_at.length > 10
                        ? new Date(item.start_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
                        : null;

                      return (
                        <button
                          key={`${item.source}-${item.id}`}
                          onClick={() => handleItemClick(item)}
                          className={cn(
                            'flex items-start gap-3 w-full text-left rounded-lg border p-3 transition-colors hover:shadow-sm',
                            cfg.bgColor,
                          )}
                        >
                          <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', cfg.color)} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                                {item.title}
                              </span>
                              <span className={cn('text-[10px] font-semibold uppercase', cfg.color)}>
                                {cfg.label}
                              </span>
                            </div>
                            {(item.subtitle || time) && (
                              <p className="text-xs text-zinc-500 mt-0.5">
                                {time && <span className="font-medium">{time}</span>}
                                {time && item.subtitle && ' - '}
                                {item.subtitle}
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Legend */}
        <div className="mt-6 flex items-center gap-4 text-xs text-zinc-500">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-blue-500" />
            Book Events
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-orange-500" />
            Bam Tasks
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-teal-500" />
            Bond Deals
          </div>
        </div>
      </div>
    </div>
  );
}
