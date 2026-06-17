import { useState, useEffect } from 'react';
import { ArrowLeft, Sun, Moon, Monitor } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface PreferencesPageProps {
  onNavigate: (path: string) => void;
}

interface UserPreferences {
  notification_sound: boolean;
  desktop_notifications: boolean;
  // Matches the banter_user_preferences.enter_sends_message column. The page
  // previously sent `enter_to_send`, which the API silently dropped (no such
  // column), so the toggle never persisted.
  enter_sends_message: boolean;
  show_typing_indicators: boolean;
  compact_mode: boolean;
}

export function PreferencesPage({ onNavigate }: PreferencesPageProps) {
  const user = useAuthStore((s) => s.user);
  const [theme, setTheme] = useState(() => localStorage.getItem('bbam-theme') ?? 'system');
  const [prefs, setPrefs] = useState<UserPreferences>({
    notification_sound: true,
    desktop_notifications: true,
    enter_sends_message: true,
    show_typing_indicators: true,
    compact_mode: false,
  });
  const [saving, setSaving] = useState(false);

  // Audio/video device selection and mute/camera defaults have moved to the
  // shared Bureau docked-box (the suite-wide LiveKit endpoint). Banter no
  // longer owns its own calling stack — see workstream Phase 2 cleanup.

  // Load preferences from API. Merge over current state so any field the
  // server omits keeps a defined boolean (avoids an uncontrolled toggle).
  useEffect(() => {
    api
      .get<{ data: Partial<UserPreferences> }>('/me/preferences')
      .then((res) => setPrefs((prev) => ({ ...prev, ...res.data })))
      .catch(() => {
        // Use defaults
      });
  }, []);

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme);
    localStorage.setItem('bbam-theme', newTheme);
    const root = document.documentElement;
    root.classList.remove('dark');
    if (newTheme === 'dark') {
      root.classList.add('dark');
    } else if (newTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.classList.add('dark');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.patch('/me/preferences', prefs);
    } catch (err) {
      console.error('Failed to save preferences:', err);
    } finally {
      setSaving(false);
    }
  };

  const updatePref = <K extends keyof UserPreferences>(key: K, value: UserPreferences[K]) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-3 px-6 h-14 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
        <button
          onClick={() => onNavigate('/channels/general')}
          className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Preferences</h2>
      </header>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-xl mx-auto px-6 py-8 space-y-8">
          {/* Profile section */}
          <section>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
              Profile
            </h3>
            <div className="flex items-center gap-4 p-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50">
              <div className="h-12 w-12 rounded-xl bg-primary-600 flex items-center justify-center text-white text-lg font-bold">
                {user?.display_name?.slice(0, 2).toUpperCase() ?? '?'}
              </div>
              <div>
                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                  {user?.display_name}
                </p>
                <p className="text-sm text-zinc-500">{user?.email}</p>
              </div>
            </div>
          </section>

          {/* Theme */}
          <section>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
              Theme
            </h3>
            <div className="flex gap-2">
              {[
                { value: 'light', label: 'Light', icon: Sun },
                { value: 'dark', label: 'Dark', icon: Moon },
                { value: 'system', label: 'System', icon: Monitor },
              ].map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => handleThemeChange(value)}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-colors',
                    theme === value
                      ? 'border-primary-400 bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </section>

          {/* Notifications */}
          <section>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
              Notifications
            </h3>
            <div className="space-y-3">
              <ToggleRow
                label="Desktop notifications"
                description="Show browser notifications for new messages"
                checked={prefs.desktop_notifications}
                onChange={(v) => updatePref('desktop_notifications', v)}
              />
              <ToggleRow
                label="Notification sound"
                description="Play a sound when you receive a message"
                checked={prefs.notification_sound}
                onChange={(v) => updatePref('notification_sound', v)}
              />
            </div>
          </section>

          {/* Messaging */}
          <section>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">
              Messaging
            </h3>
            <div className="space-y-3">
              <ToggleRow
                label="Enter to send"
                description="Press Enter to send messages (Shift+Enter for newline)"
                checked={prefs.enter_sends_message}
                onChange={(v) => updatePref('enter_sends_message', v)}
              />
              <ToggleRow
                label="Show typing indicators"
                description="See when others are typing"
                checked={prefs.show_typing_indicators}
                onChange={(v) => updatePref('show_typing_indicators', v)}
              />
              <ToggleRow
                label="Compact mode"
                description="Reduce spacing between messages"
                checked={prefs.compact_mode}
                onChange={(v) => updatePref('compact_mode', v)}
              />
            </div>
          </section>

          {/* Audio & Video device settings live in the shared Bureau
              docked-box. The huddle for the channel you're viewing is
              already the room your Bureau client is in. */}

          {/* Save */}
          <div className="pt-4">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-6 py-2.5 rounded-xl bg-primary-600 text-white font-medium text-sm hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save Preferences'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50">
      <div>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          'relative w-10 h-6 rounded-full transition-colors flex-shrink-0',
          checked ? 'bg-primary-600' : 'bg-zinc-300 dark:bg-zinc-600',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
            checked && 'translate-x-4',
          )}
        />
      </button>
    </div>
  );
}
