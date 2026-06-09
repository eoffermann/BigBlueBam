import { useState, useMemo } from 'react';
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  isToday,
  format,
  addMonths,
  subMonths,
  parseISO,
} from 'date-fns';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { Phase, Task, Priority } from '@bigbluebam/shared';
import { cn, truncate } from '@/lib/utils';
import { CalendarExportMenu } from './calendar-export-menu';

interface CalendarViewProps {
  phases: (Phase & { tasks: Task[] })[];
  onTaskClick: (taskId: string) => void;
  projectId?: string;
  projectName?: string;
}

const PRIORITY_DOT_COLORS: Record<Priority, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-400',
  medium: 'bg-yellow-400',
  low: 'bg-blue-400',
  none: 'bg-zinc-400',
};

const PRIORITY_TEXT_COLORS: Record<Priority, string> = {
  critical: 'text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950/30',
  high: 'text-orange-700 bg-orange-50 dark:text-orange-400 dark:bg-orange-950/30',
  medium: 'text-yellow-700 bg-yellow-50 dark:text-yellow-400 dark:bg-yellow-950/30',
  low: 'text-blue-700 bg-blue-50 dark:text-blue-400 dark:bg-blue-950/30',
  none: 'text-zinc-600 bg-zinc-50 dark:text-zinc-400 dark:bg-zinc-800',
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function CalendarView({ phases, onTaskClick, projectId, projectName }: CalendarViewProps) {
  const [currentMonth, setCurrentMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  const allTasks = useMemo(() => phases.flatMap((p) => p.tasks), [phases]);

  // Build a map of date -> tasks
  const tasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of allTasks) {
      if (task.due_date) {
        const key = format(parseISO(task.due_date), 'yyyy-MM-dd');
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(task);
      }
    }
    return map;
  }, [allTasks]);

  // Calendar grid days
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
    const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
    return eachDayOfInterval({ start: gridStart, end: gridEnd });
  }, [currentMonth]);

  const selectedDayTasks = useMemo(() => {
    if (!selectedDay) return [];
    const key = format(selectedDay, 'yyyy-MM-dd');
    return tasksByDate.get(key) ?? [];
  }, [selectedDay, tasksByDate]);

  return (
    <div className="flex flex-col h-full">
      {/* Header with navigation */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setCurrentMonth((m) => subMonths(m, 1))}
            className="rounded-md p-1.5 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 min-w-[180px] text-center">
            {format(currentMonth, 'MMMM yyyy')}
          </h2>
          <button
            onClick={() => setCurrentMonth((m) => addMonths(m, 1))}
            className="rounded-md p-1.5 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            aria-label="Next month"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setCurrentMonth(startOfMonth(new Date()))}
            className="text-sm text-primary-600 hover:text-primary-700 font-medium"
          >
            Today
          </button>
          {projectId && (
            <CalendarExportMenu projectId={projectId} projectName={projectName ?? 'Project'} />
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Calendar grid */}
        <div className="flex-1 flex flex-col overflow-auto p-4">
          {/* Weekday headers */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map((day) => (
              <div key={day} className="text-center text-xs font-medium text-zinc-500 py-2">
                {day}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 flex-1 gap-px bg-zinc-200 dark:bg-zinc-800 rounded-lg overflow-hidden">
            {calendarDays.map((day) => {
              const key = format(day, 'yyyy-MM-dd');
              const tasks = tasksByDate.get(key) ?? [];
              const inMonth = isSameMonth(day, currentMonth);
              const today = isToday(day);
              const isSelected = selectedDay ? isSameDay(day, selectedDay) : false;

              return (
                <button
                  key={key}
                  onClick={() => setSelectedDay(isSelected ? null : day)}
                  className={cn(
                    'flex flex-col items-start p-2 min-h-[80px] bg-white dark:bg-zinc-900 text-left transition-colors',
                    !inMonth && 'opacity-40',
                    isSelected && 'ring-2 ring-inset ring-primary-500',
                    !isSelected && 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
                  )}
                  aria-label={`${format(day, 'MMMM d, yyyy')}, ${tasks.length} tasks`}
                >
                  <span
                    className={cn(
                      'inline-flex items-center justify-center h-6 w-6 rounded-full text-xs font-medium',
                      today
                        ? 'bg-red-500 text-white'
                        : 'text-zinc-700 dark:text-zinc-300',
                    )}
                  >
                    {format(day, 'd')}
                  </span>

                  {/* Task dot indicators */}
                  {tasks.length > 0 && (
                    <div className="flex items-center gap-0.5 mt-1 flex-wrap">
                      {tasks.length <= 5 ? (
                        tasks.map((t) => (
                          <span
                            key={t.id}
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              PRIORITY_DOT_COLORS[t.priority] ?? 'bg-zinc-400',
                            )}
                          />
                        ))
                      ) : (
                        <>
                          {tasks.slice(0, 3).map((t) => (
                            <span
                              key={t.id}
                              className={cn(
                                'h-1.5 w-1.5 rounded-full',
                                PRIORITY_DOT_COLORS[t.priority] ?? 'bg-zinc-400',
                              )}
                            />
                          ))}
                          <span className="text-[9px] text-zinc-400 ml-0.5">
                            +{tasks.length - 3}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected day panel */}
        <AnimatePresence>
          {selectedDay && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shrink-0"
            >
              <div className="w-80 h-full flex flex-col">
                <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {format(selectedDay, 'EEEE, MMMM d')}
                  </h3>
                  <button
                    onClick={() => setSelectedDay(null)}
                    className="rounded-md p-1 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                  {selectedDayTasks.length === 0 ? (
                    <p className="text-sm text-zinc-400 text-center py-8">
                      No tasks due on this day.
                    </p>
                  ) : (
                    selectedDayTasks.map((task) => (
                      <button
                        key={task.id}
                        onClick={() => onTaskClick(task.id)}
                        className={cn(
                          'w-full text-left rounded-lg p-3 text-sm transition-colors',
                          PRIORITY_TEXT_COLORS[task.priority] ?? 'bg-zinc-50 text-zinc-700',
                          'hover:brightness-95',
                        )}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-mono opacity-60">{task.human_id}</span>
                          <span
                            className={cn(
                              'h-2 w-2 rounded-full',
                              PRIORITY_DOT_COLORS[task.priority],
                            )}
                          />
                        </div>
                        <p className="font-medium leading-snug">
                          {truncate(task.title, 60)}
                        </p>
                        {task.story_points != null && (
                          <span className="text-xs opacity-60 mt-1 inline-block">
                            {task.story_points} pts
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
