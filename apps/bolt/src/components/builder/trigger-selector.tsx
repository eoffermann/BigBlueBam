import type { TriggerSource } from '@/hooks/use-automations';
import { useEventsBySource } from '@/hooks/use-event-catalog';
import { TRIGGER_SOURCE_OPTIONS } from '@/lib/trigger-sources';

interface TriggerSelectorProps {
  source: TriggerSource | undefined;
  eventType: string;
  onSourceChange: (source: TriggerSource) => void;
  onEventTypeChange: (eventType: string) => void;
}

// Derived from BOLT_SOURCES in @bigbluebam/shared (issue #133).
const triggerSources = TRIGGER_SOURCE_OPTIONS;

export function TriggerSelector({ source, eventType, onSourceChange, onEventTypeChange }: TriggerSelectorProps) {
  const { data: events, isLoading } = useEventsBySource(source);

  return (
    <div className="flex flex-col gap-3">
      {/* Source dropdown */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Trigger Source
        </label>
        <select
          value={source ?? ''}
          onChange={(e) => {
            onSourceChange(e.target.value as TriggerSource);
            onEventTypeChange('');
          }}
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-700"
        >
          <option value="">Select a source...</option>
          {triggerSources.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Event type dropdown */}
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Event Type
        </label>
        <select
          value={eventType}
          onChange={(e) => onEventTypeChange(e.target.value)}
          disabled={!source}
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-700"
        >
          <option value="">
            {!source ? 'Select a source first...' : isLoading ? 'Loading events...' : 'Select an event...'}
          </option>
          {events.map((evt) => (
            <option key={evt.event_type} value={evt.event_type}>
              {evt.event_type} — {evt.description}
            </option>
          ))}
        </select>
      </div>

      {/* Selected event description */}
      {eventType && events.length > 0 && (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-2 border border-blue-200 dark:border-blue-800">
          {events.find((e) => e.event_type === eventType)?.description ?? 'Unknown event type'}
        </div>
      )}
    </div>
  );
}
