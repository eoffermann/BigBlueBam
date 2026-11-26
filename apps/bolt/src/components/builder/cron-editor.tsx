import { useState, useCallback, useMemo } from 'react';
import { Clock } from 'lucide-react';

// ─── Timezone helpers ─────────────────────────────────────────────────────────

/** Get all IANA timezone names supported by the runtime, or fall back to a curated list. */
function getTimezoneOptions(): string[] {
  try {
    // Available in modern browsers / Node 18+
    const zones = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
    if (zones && zones.length > 0) return zones;
  } catch {
    // fall through to hardcoded list
  }
  return [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Anchorage',
    'America/Halifax',
    'America/Sao_Paulo',
    'America/Argentina/Buenos_Aires',
    'America/Toronto',
    'America/Vancouver',
    'America/Mexico_City',
    'America/Bogota',
    'America/Lima',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Madrid',
    'Europe/Rome',
    'Europe/Amsterdam',
    'Europe/Stockholm',
    'Europe/Warsaw',
    'Europe/Moscow',
    'Europe/Istanbul',
    'Africa/Cairo',
    'Africa/Johannesburg',
    'Africa/Lagos',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Dhaka',
    'Asia/Bangkok',
    'Asia/Singapore',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Asia/Seoul',
    'Asia/Hong_Kong',
    'Australia/Perth',
    'Australia/Adelaide',
    'Australia/Sydney',
    'Pacific/Auckland',
    'Pacific/Honolulu',
  ];
}

/** Detect user's local timezone, fallback UTC. */
function getUserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

interface CronEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** IANA timezone string. Defaults to user's local timezone. */
  timezone?: string;
  onTimezoneChange?: (tz: string) => void;
}

type Preset = {
  label: string;
  cron: string;
  description: string;
};

const PRESETS: Preset[] = [
  { label: 'Every minute', cron: '* * * * *', description: 'Runs every minute' },
  { label: 'Every 5 minutes', cron: '*/5 * * * *', description: 'Runs every 5 minutes' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *', description: 'Runs every 15 minutes' },
  { label: 'Every hour', cron: '0 * * * *', description: 'At the start of every hour' },
  { label: 'Every day at 9 AM', cron: '0 9 * * *', description: 'Daily at 9:00 AM' },
  { label: 'Every day at 6 PM', cron: '0 18 * * *', description: 'Daily at 6:00 PM' },
  { label: 'Weekdays at 9 AM', cron: '0 9 * * 1-5', description: 'Monday-Friday at 9:00 AM' },
  { label: 'Every Monday at 9 AM', cron: '0 9 * * 1', description: 'Mondays at 9:00 AM' },
  { label: 'Every Friday at 5 PM', cron: '0 17 * * 5', description: 'Fridays at 5:00 PM' },
  { label: 'First of every month', cron: '0 9 1 * *', description: '1st of each month at 9:00 AM' },
  { label: 'Every Sunday at midnight', cron: '0 0 * * 0', description: 'Sundays at midnight' },
];

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type EditorMode = 'presets' | 'custom' | 'advanced';

function parseCronParts(cron: string): { minute: string; hour: string; dayOfMonth: string; month: string; dayOfWeek: string } {
  const parts = cron.trim().split(/\s+/);
  return {
    minute: parts[0] ?? '*',
    hour: parts[1] ?? '*',
    dayOfMonth: parts[2] ?? '*',
    month: parts[3] ?? '*',
    dayOfWeek: parts[4] ?? '*',
  };
}

function describeCron(cron: string): string {
  if (!cron || !cron.trim()) return 'Not configured';

  const preset = PRESETS.find((p) => p.cron === cron);
  if (preset) return preset.description;

  const parts = parseCronParts(cron);
  const segments: string[] = [];

  // Minute
  if (parts.minute === '*') segments.push('every minute');
  else if (parts.minute.startsWith('*/')) segments.push(`every ${parts.minute.slice(2)} minutes`);
  else segments.push(`at minute ${parts.minute}`);

  // Hour
  if (parts.hour !== '*') {
    if (parts.hour.startsWith('*/')) segments.push(`every ${parts.hour.slice(2)} hours`);
    else {
      const h = Number.parseInt(parts.hour, 10);
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      segments.push(`at ${h12}:${parts.minute === '*' ? '00' : parts.minute.padStart(2, '0')} ${ampm}`);
    }
  }

  // Day of week
  if (parts.dayOfWeek !== '*') {
    if (parts.dayOfWeek === '1-5') segments.push('on weekdays');
    else if (parts.dayOfWeek === '0,6') segments.push('on weekends');
    else {
      const dayNums = parts.dayOfWeek.split(',').map((d) => DAYS_OF_WEEK[Number.parseInt(d, 10)] ?? d);
      segments.push(`on ${dayNums.join(', ')}`);
    }
  }

  // Day of month
  if (parts.dayOfMonth !== '*') {
    segments.push(`on day ${parts.dayOfMonth} of the month`);
  }

  return segments.join(', ') || cron;
}

export function CronEditor({ value, onChange, timezone, onTimezoneChange }: CronEditorProps) {
  const [mode, setMode] = useState<EditorMode>('presets');

  // Lazily compute timezone list — stable across renders
  const timezoneOptions = useMemo(() => getTimezoneOptions(), []);
  const effectiveTimezone = timezone || getUserTimezone();

  const parts = parseCronParts(value);

  const updatePart = useCallback(
    (field: keyof ReturnType<typeof parseCronParts>, newValue: string) => {
      const p = parseCronParts(value);
      p[field] = newValue;
      onChange(`${p.minute} ${p.hour} ${p.dayOfMonth} ${p.month} ${p.dayOfWeek}`);
    },
    [value, onChange],
  );

  return (
    <div className="space-y-3">
      {/* Mode selector */}
      <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
        {(['presets', 'custom', 'advanced'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 text-xs font-medium px-2 py-1.5 rounded-md transition-colors ${
              mode === m
                ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            {m === 'presets' ? 'Presets' : m === 'custom' ? 'Custom' : 'Advanced'}
          </button>
        ))}
      </div>

      {/* Presets mode */}
      {mode === 'presets' && (
        <div className="space-y-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.cron}
              type="button"
              onClick={() => onChange(preset.cron)}
              className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                value === preset.cron
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                  : 'border-zinc-200 dark:border-zinc-700 hover:border-blue-300 dark:hover:border-blue-700 text-zinc-700 dark:text-zinc-300'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">{preset.label}</span>
                <span className="text-xs text-zinc-400 font-mono">{preset.cron}</span>
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">{preset.description}</p>
            </button>
          ))}
        </div>
      )}

      {/* Custom mode */}
      {mode === 'custom' && (
        <div className="space-y-3">
          {/* Time picker */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-500 mb-1">Hour</label>
              <select
                value={parts.hour}
                onChange={(e) => updatePart('hour', e.target.value)}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-blue-500 outline-none"
              >
                <option value="*">Every hour</option>
                {Array.from({ length: 24 }, (_, i) => {
                  const ampm = i >= 12 ? 'PM' : 'AM';
                  const h12 = i === 0 ? 12 : i > 12 ? i - 12 : i;
                  return (
                    <option key={i} value={String(i)}>{h12}:00 {ampm}</option>
                  );
                })}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-500 mb-1">Minute</label>
              <select
                value={parts.minute}
                onChange={(e) => updatePart('minute', e.target.value)}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-blue-500 outline-none"
              >
                <option value="0">:00</option>
                <option value="5">:05</option>
                <option value="10">:10</option>
                <option value="15">:15</option>
                <option value="20">:20</option>
                <option value="30">:30</option>
                <option value="45">:45</option>
              </select>
            </div>
          </div>

          {/* Day of week */}
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1.5">Days of week</label>
            <div className="flex gap-1">
              {DAYS_OF_WEEK.map((day, i) => {
                const isAll = parts.dayOfWeek === '*';
                const selected = isAll || parts.dayOfWeek.split(',').includes(String(i));
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => {
                      if (isAll) {
                        // Switch from "all" to just this day
                        updatePart('dayOfWeek', String(i));
                      } else {
                        const current = parts.dayOfWeek.split(',').filter(Boolean);
                        if (selected) {
                          const next = current.filter((d) => d !== String(i));
                          updatePart('dayOfWeek', next.length === 0 ? '*' : next.join(','));
                        } else {
                          const next = [...current, String(i)].sort();
                          updatePart('dayOfWeek', next.length === 7 ? '*' : next.join(','));
                        }
                      }
                    }}
                    className={`flex-1 text-xs font-medium py-1.5 rounded-md border transition-colors ${
                      selected
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                        : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:border-blue-300'
                    }`}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2 mt-1.5">
              <button
                type="button"
                onClick={() => updatePart('dayOfWeek', '*')}
                className="text-[10px] text-blue-500 hover:text-blue-600"
              >
                All days
              </button>
              <button
                type="button"
                onClick={() => updatePart('dayOfWeek', '1,2,3,4,5')}
                className="text-[10px] text-blue-500 hover:text-blue-600"
              >
                Weekdays
              </button>
              <button
                type="button"
                onClick={() => updatePart('dayOfWeek', '0,6')}
                className="text-[10px] text-blue-500 hover:text-blue-600"
              >
                Weekends
              </button>
            </div>
          </div>

          {/* Day of month */}
          <div>
            <label className="block text-xs font-medium text-zinc-500 mb-1">Day of month</label>
            <select
              value={parts.dayOfMonth}
              onChange={(e) => updatePart('dayOfMonth', e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="*">Every day</option>
              {Array.from({ length: 31 }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>{i + 1}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Advanced mode (raw cron input) */}
      {mode === 'advanced' && (
        <div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="0 9 * * 1-5"
              className="flex-1 rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2.5 py-1.5 text-sm font-mono text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <p className="text-[10px] text-zinc-400 mt-1.5 font-mono">
            minute(0-59) hour(0-23) day(1-31) month(1-12) weekday(0-6)
          </p>
        </div>
      )}

      {/* Timezone selector */}
      {onTimezoneChange && (
        <div>
          <label className="block text-xs font-medium text-zinc-500 mb-1">Timezone</label>
          <select
            value={effectiveTimezone}
            onChange={(e) => onTimezoneChange(e.target.value)}
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 focus:ring-2 focus:ring-blue-500 outline-none"
          >
            {timezoneOptions.map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </div>
      )}

      {/* Current value description */}
      {value && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800/50">
          <Clock className="h-3.5 w-3.5 text-blue-500 shrink-0" />
          <span className="text-xs text-blue-700 dark:text-blue-300">{describeCron(value)}</span>
          <span className="ml-auto text-[10px] font-mono text-blue-400">{value}</span>
          {onTimezoneChange && (
            <span className="text-[10px] font-mono text-blue-400 shrink-0">{effectiveTimezone}</span>
          )}
        </div>
      )}
    </div>
  );
}
