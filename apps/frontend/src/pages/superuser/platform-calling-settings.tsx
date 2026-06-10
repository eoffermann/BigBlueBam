import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Loader2,
  PhoneCall,
  Power,
  Save,
  Server,
  Shield,
  KeyRound,
  Lock,
  Bot,
  AlertTriangle,
  Check,
  RotateCw,
  X,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';

interface PlatformCallingSettingsPageProps {
  onNavigate: (path: string) => void;
}

// ── Setting key catalog ────────────────────────────────────────────────
// Order matters: this drives the render order on the page.
type CallingKey =
  | 'calling.global_enabled'
  | 'calling.livekit_host'
  | 'calling.livekit_api_key'
  | 'calling.livekit_api_secret'
  | 'calling.voice_agent_url';

const KEYS: readonly CallingKey[] = [
  'calling.global_enabled',
  'calling.livekit_host',
  'calling.livekit_api_key',
  'calling.livekit_api_secret',
  'calling.voice_agent_url',
] as const;

interface SystemSettingRow {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: string;
  is_secret?: boolean;
}

interface SystemSettingResponse {
  data: SystemSettingRow | null;
}

export function PlatformCallingSettingsPage({
  onNavigate,
}: PlatformCallingSettingsPageProps) {
  const { user } = useAuthStore();

  useEffect(() => {
    if (user && user.is_superuser !== true) {
      onNavigate('/');
    }
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
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-3">
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
              Platform calling settings
            </h1>
            <p className="text-xs text-zinc-500">
              LiveKit + voice agent credentials and global kill switch.
            </p>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-6 flex flex-col gap-4">
        {KEYS.map((key) => (
          <SettingCard key={key} settingKey={key} />
        ))}
      </main>
    </div>
  );
}

// ── Per-key card ────────────────────────────────────────────────────────

interface CardMeta {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  iconBg: string;
  iconColor: string;
  kind: 'boolean' | 'string' | 'secret';
  placeholder?: string;
  helpUnit?: string;
}

const META: Record<CallingKey, CardMeta> = {
  'calling.global_enabled': {
    title: 'Global calling kill switch',
    description:
      'When OFF, no app can start a call regardless of per-org configuration. Use this to disable calling platform-wide for an incident or compliance pause. Defaults to ON when unset.',
    icon: Power,
    iconBg: 'bg-emerald-100 dark:bg-emerald-900/30',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    kind: 'boolean',
  },
  'calling.livekit_host': {
    title: 'LiveKit host URL',
    description:
      'Public URL of the LiveKit SFU (e.g. https://livekit.example.com). Overrides the LIVEKIT_HOST env var. Must be a publicly reachable https URL — private IPs and internal hostnames are rejected.',
    icon: Server,
    iconBg: 'bg-blue-100 dark:bg-blue-900/30',
    iconColor: 'text-blue-600 dark:text-blue-400',
    kind: 'string',
    placeholder: 'https://livekit.example.com',
  },
  'calling.livekit_api_key': {
    title: 'LiveKit API key',
    description:
      'API key used to mint LiveKit access tokens. Stored masked — to change it, use the Rotate button and enter the new value.',
    icon: KeyRound,
    iconBg: 'bg-amber-100 dark:bg-amber-900/30',
    iconColor: 'text-amber-600 dark:text-amber-400',
    kind: 'secret',
    placeholder: 'APIxxxxxxxxxxxx',
    helpUnit: '4–256 chars',
  },
  'calling.livekit_api_secret': {
    title: 'LiveKit API secret',
    description:
      'Signing secret paired with the API key. Stored masked — only the last 4 characters are visible. Treat rotations as production-impacting: every active call will need to refresh its token.',
    icon: Lock,
    iconBg: 'bg-red-100 dark:bg-red-900/30',
    iconColor: 'text-red-600 dark:text-red-400',
    kind: 'secret',
    placeholder: 'paste the new secret here',
    helpUnit: '16–512 chars',
  },
  'calling.voice_agent_url': {
    title: 'Voice agent service URL',
    description:
      'Public URL of the voice-agent service that joins LiveKit rooms on behalf of an AI agent. Must be a publicly reachable https URL.',
    icon: Bot,
    iconBg: 'bg-purple-100 dark:bg-purple-900/30',
    iconColor: 'text-purple-600 dark:text-purple-400',
    kind: 'string',
    placeholder: 'https://voice-agent.example.com',
  },
};

function SettingCard({ settingKey }: { settingKey: CallingKey }) {
  const meta = META[settingKey];
  const queryClient = useQueryClient();

  // GET — tolerate 404 (the setting has never been written before).
  const { data, isLoading } = useQuery<SystemSettingResponse>({
    queryKey: ['system-settings', settingKey],
    queryFn: async () => {
      try {
        return await api.get<SystemSettingResponse>(`/system-settings/${settingKey}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return { data: null };
        }
        throw err;
      }
    },
  });

  const row = data?.data ?? null;
  const stored = row?.value;

  // Local UI state.
  // - boolean kind: drives the toggle directly
  // - string kind: holds the edit-mode draft (initialised from `stored`)
  // - secret kind: starts in display mode; "Rotate" puts it in edit mode
  //                with an empty draft so the operator types the new value.
  const [draftString, setDraftString] = useState('');
  const [rotateMode, setRotateMode] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Sync draft when the server value changes (and we're not in the middle
  // of typing a rotation).
  useEffect(() => {
    if (meta.kind === 'string' && !rotateMode) {
      setDraftString(typeof stored === 'string' ? stored : '');
    }
  }, [stored, meta.kind, rotateMode]);

  const save = useMutation({
    mutationFn: (value: unknown) =>
      api.put<{ data: SystemSettingRow }>(`/system-settings/${settingKey}`, { value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-settings', settingKey] });
      setRotateMode(false);
      setLocalError(null);
    },
    onError: (err: Error) => {
      setLocalError(err.message);
    },
  });

  const Icon = meta.icon;

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
      <div className="flex items-start gap-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${meta.iconBg}`}
        >
          <Icon className={`h-5 w-5 ${meta.iconColor}`} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {meta.title}
          </h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {meta.description}
          </p>

          {isLoading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : meta.kind === 'boolean' ? (
            <BooleanEditor
              stored={stored}
              saving={save.isPending}
              onChange={(next) => save.mutate(next)}
            />
          ) : meta.kind === 'secret' ? (
            <SecretEditor
              stored={stored}
              row={row}
              meta={meta}
              rotateMode={rotateMode}
              draft={draftString}
              setDraft={setDraftString}
              setRotateMode={(v) => {
                setRotateMode(v);
                if (!v) setDraftString('');
                setLocalError(null);
              }}
              saving={save.isPending}
              onSave={() => {
                if (!draftString) {
                  setLocalError('Enter a new value before saving.');
                  return;
                }
                save.mutate(draftString);
              }}
            />
          ) : (
            <StringEditor
              stored={stored}
              row={row}
              meta={meta}
              draft={draftString}
              setDraft={setDraftString}
              saving={save.isPending}
              onSave={() => save.mutate(draftString)}
              onReset={() => {
                setDraftString(typeof stored === 'string' ? stored : '');
                setLocalError(null);
              }}
            />
          )}

          {(localError || save.isError) && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4" />
              {localError ?? (save.error as Error)?.message}
            </p>
          )}
          {save.isSuccess && !save.isError && !localError && (
            <p className="mt-2 text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
              <Check className="h-3.5 w-3.5" />
              Saved.
              {row?.updated_at && (
                <span className="ml-1 text-zinc-500">
                  · {new Date(row.updated_at).toLocaleString()}
                </span>
              )}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

// ── Boolean toggle ─────────────────────────────────────────────────────

function BooleanEditor({
  stored,
  saving,
  onChange,
}: {
  stored: unknown;
  saving: boolean;
  onChange: (next: boolean) => void;
}) {
  // Treat unset (null/undefined) as ON — calling defaults enabled platform-wide.
  const enabled = stored === undefined || stored === null ? true : Boolean(stored);
  return (
    <div className="mt-4 flex items-center gap-3">
      <button
        onClick={() => onChange(!enabled)}
        disabled={saving}
        className={
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ' +
          (enabled ? 'bg-primary-600' : 'bg-zinc-300 dark:bg-zinc-700')
        }
        role="switch"
        aria-checked={enabled}
        aria-label="Toggle calling global kill switch"
      >
        <span
          className={
            'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ' +
            (enabled ? 'translate-x-5' : 'translate-x-0.5')
          }
        />
      </button>
      <div className="text-sm">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">
          {enabled ? 'Calling enabled' : 'Calling disabled (kill switch ON)'}
        </span>
      </div>
      {saving && <Loader2 className="h-4 w-4 animate-spin text-primary-500" />}
    </div>
  );
}

// ── Plain string editor (URLs) ─────────────────────────────────────────

function StringEditor({
  stored,
  row,
  meta,
  draft,
  setDraft,
  saving,
  onSave,
  onReset,
}: {
  stored: unknown;
  row: SystemSettingRow | null;
  meta: CardMeta;
  draft: string;
  setDraft: (v: string) => void;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  const storedStr = typeof stored === 'string' ? stored : '';
  const dirty = draft !== storedStr;

  return (
    <div className="mt-4 flex flex-col gap-2">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={meta.placeholder ?? ''}
        spellCheck={false}
        autoComplete="off"
      />
      <div className="flex items-center gap-2">
        <Button onClick={onSave} loading={saving} disabled={saving || !dirty || draft.length === 0}>
          <Save className="h-4 w-4" />
          Save
        </Button>
        {dirty && (
          <Button variant="secondary" onClick={onReset} disabled={saving}>
            <X className="h-4 w-4" />
            Cancel
          </Button>
        )}
        {row?.updated_at && !dirty && (
          <span className="text-xs text-zinc-500">
            Last changed {new Date(row.updated_at).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Masked secret editor ───────────────────────────────────────────────
// Two modes:
//   1. Display: shows the masked stored value (read-only) + "Rotate" button.
//   2. Rotate: empty input bound to draftString, "Save" / "Cancel" actions.

function SecretEditor({
  stored,
  row,
  meta,
  rotateMode,
  draft,
  setDraft,
  setRotateMode,
  saving,
  onSave,
}: {
  stored: unknown;
  row: SystemSettingRow | null;
  meta: CardMeta;
  rotateMode: boolean;
  draft: string;
  setDraft: (v: string) => void;
  setRotateMode: (v: boolean) => void;
  saving: boolean;
  onSave: () => void;
}) {
  const masked = typeof stored === 'string' ? stored : '';

  if (!rotateMode) {
    return (
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex items-center gap-2 font-mono text-sm rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 px-3 py-2 text-zinc-700 dark:text-zinc-300">
          {masked ? (
            <span>{masked}</span>
          ) : (
            <span className="text-zinc-400 italic">not configured</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setRotateMode(true)} disabled={saving}>
            <RotateCw className="h-4 w-4" />
            {masked ? 'Rotate' : 'Set value'}
          </Button>
          {row?.updated_at && (
            <span className="text-xs text-zinc-500">
              Last rotated {new Date(row.updated_at).toLocaleString()}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-2">
      <Input
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={meta.placeholder ?? 'paste the new value'}
        spellCheck={false}
        autoComplete="off"
        autoFocus
      />
      {meta.helpUnit && (
        <p className="text-xs text-zinc-500">{meta.helpUnit}.</p>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={onSave} loading={saving} disabled={saving || draft.length === 0}>
          <Save className="h-4 w-4" />
          Save new value
        </Button>
        <Button variant="secondary" onClick={() => setRotateMode(false)} disabled={saving}>
          <X className="h-4 w-4" />
          Cancel
        </Button>
      </div>
    </div>
  );
}

// Re-export the icon so the parent SuperUser console can pull it for the nav card.
export const PlatformCallingNavIcon = PhoneCall;
