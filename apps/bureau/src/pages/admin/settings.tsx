/**
 * Org-settings screen — /bureau/admin/settings.
 *
 * Surfaces the org-wide Bureau settings the API exposes (GET /v1/settings,
 * PATCH /v1/settings):
 *   - continuous_audio          always-on spatial audio
 *   - allow_auto_follow         permit being pulled along on navigation
 *   - default_office_privacy    door state new offices boot with
 *   - members_can_book          whether non-admins may reserve rooms
 *   - members_can_create_rooms  whether non-admins may create rooms
 *
 * Any member can READ the settings; only org admins/owners (or SuperUsers)
 * may change them (the API 403s otherwise). For a non-admin the controls
 * render read-only with an explanatory banner, matching the offices page
 * pattern.
 */

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Settings as SettingsIcon,
  Shield,
} from 'lucide-react';
import { BureauApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuthStore, type BureauUser } from '@/stores/auth.store';
import {
  useBureauSettings,
  useUpdateBureauSettings,
  type BureauSettingsPatch,
} from '@/hooks/use-settings';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}
function canManageSettings(user: BureauUser | null): boolean {
  if (!user) return false;
  if (user.is_superuser) return true;
  return roleLevel(user.role) >= roleLevel('admin');
}

export function AdminSettingsPage() {
  const user = useAuthStore((s) => s.user);
  const canEdit = canManageSettings(user);
  const settingsQuery = useBureauSettings();
  const updateMutation = useUpdateBureauSettings();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savedField, setSavedField] = useState<string | null>(null);

  function apply(patch: BureauSettingsPatch, field: string) {
    setErrorMessage(null);
    updateMutation.mutate(patch, {
      onSuccess: () => {
        setSavedField(field);
        window.setTimeout(() => setSavedField((f) => (f === field ? null : f)), 1500);
      },
      onError: (err) => {
        setErrorMessage(err instanceof BureauApiError ? err.message : String(err));
      },
    });
  }

  if (settingsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (settingsQuery.error) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-4 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Failed to load settings: {(settingsQuery.error as Error).message}
          </div>
        </div>
      </div>
    );
  }

  const settings = settingsQuery.data!;
  const busyField = updateMutation.isPending ? Object.keys(updateMutation.variables ?? {})[0] : null;

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <SettingsIcon className="h-5 w-5 text-zinc-400" />
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          Bureau settings
        </h1>
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
        Org-wide defaults for spatial audio, follow, and what members can do.
      </p>

      {!canEdit && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-4 flex items-start gap-3">
          <Shield className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800 dark:text-amber-200">
            These settings are read-only for your role. Only org admins or
            owners can change them.
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="text-sm text-red-700 dark:text-red-300">{errorMessage}</div>
        </div>
      )}

      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-200 dark:divide-zinc-800">
        <ToggleRow
          label="Continuous audio"
          hint="Keep always-on spatial audio open as people move around a floor."
          checked={settings.continuous_audio}
          disabled={!canEdit || busyField === 'continuous_audio'}
          saved={savedField === 'continuous_audio'}
          onChange={(v) => apply({ continuous_audio: v }, 'continuous_audio')}
        />
        <ToggleRow
          label="Allow auto-follow"
          hint="Permit being pulled along when a colleague navigates (the Bring feature)."
          checked={settings.allow_auto_follow}
          disabled={!canEdit || busyField === 'allow_auto_follow'}
          saved={savedField === 'allow_auto_follow'}
          onChange={(v) => apply({ allow_auto_follow: v }, 'allow_auto_follow')}
        />
        <ToggleRow
          label="Members can book rooms"
          hint="When off, only admins and owners can reserve rooms."
          checked={settings.members_can_book}
          disabled={!canEdit || busyField === 'members_can_book'}
          saved={savedField === 'members_can_book'}
          onChange={(v) => apply({ members_can_book: v }, 'members_can_book')}
        />
        <ToggleRow
          label="Members can create rooms"
          hint="When off, only admins and owners can add rooms to a floor."
          checked={settings.members_can_create_rooms}
          disabled={!canEdit || busyField === 'members_can_create_rooms'}
          saved={savedField === 'members_can_create_rooms'}
          onChange={(v) =>
            apply({ members_can_create_rooms: v }, 'members_can_create_rooms')
          }
        />
        <SelectRow
          label="Default office privacy"
          hint="The door state a newly created office starts with."
          value={settings.default_office_privacy}
          disabled={!canEdit || busyField === 'default_office_privacy'}
          saved={savedField === 'default_office_privacy'}
          options={[
            { value: 'open', label: 'Open (anyone can enter)' },
            { value: 'knock', label: 'Knock (visitors must knock)' },
            { value: 'private', label: 'Private (ACL only)' },
          ]}
          onChange={(v) =>
            apply(
              { default_office_privacy: v as 'open' | 'knock' | 'private' },
              'default_office_privacy',
            )
          }
        />
      </div>
    </div>
  );
}

interface RowBaseProps {
  label: string;
  hint: string;
  disabled: boolean;
  saved: boolean;
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  saved,
  onChange,
}: RowBaseProps & { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {label}
          </span>
          {saved && <SavedBadge />}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-primary-600' : 'bg-zinc-300 dark:bg-zinc-700',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
    </div>
  );
}

function SelectRow({
  label,
  hint,
  value,
  options,
  disabled,
  saved,
  onChange,
}: RowBaseProps & {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {label}
          </span>
          {saved && <SavedBadge />}
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{hint}</p>
      </div>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SavedBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-600 dark:text-green-400">
      <CheckCircle2 className="h-3 w-3" />
      Saved
    </span>
  );
}
