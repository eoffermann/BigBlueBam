/**
 * Org Admin → Calling Settings page (P-3 from docs/plans/bureau-calling-audit.md).
 *
 * Surfaces the 13 calling/agent knobs from `banter_settings` to the org admin.
 * The existing /admin page in this app covers many of the same fields, but it
 * mixes them with channel-creation / message-retention / file-size knobs and
 * lacks the explicit "use platform default vs override" affordance the audit
 * called for on LiveKit credentials. This page is the dedicated, audit-aligned
 * surface that bureau-calling-smoke-tests will screenshot.
 *
 * Gate: `useCan('banter.admin_setting.update')` matches the API's PATCH gate.
 * Non-admins see a polite "access denied" panel.
 *
 * Secrets: the API returns masked secrets (leading `*`). We never PATCH a
 * masked value back — only the fields the user explicitly clicked "Replace"
 * on AND typed a new value into are sent.
 *
 * Provider config editor: structured form (api_key + model/voice + endpoint_url)
 * is the primary UI to stay consistent with the existing /admin page. An
 * "Advanced (JSON)" toggle exposes the raw object for anything the structured
 * form doesn't surface — useful for provider-specific knobs the platform team
 * adds without shipping a UI change.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  ArrowLeft,
  Video,
  Disc,
  FileText,
  Bot,
  Server,
  Save,
  Loader2,
  CheckCircle,
  AlertCircle,
  Eye,
  EyeOff,
  RefreshCw,
} from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface AdminCallingSettingsPageProps {
  onNavigate: (path: string) => void;
}

type ProviderConfig = Record<string, unknown>;

interface AdminSettings {
  // Voice & Video
  voice_video_enabled: boolean;
  max_call_participants: number;
  max_call_duration_minutes: number;

  // Recording
  allow_recording: boolean;
  recording_storage_prefix: string;

  // Transcription
  transcription_enabled: boolean;
  stt_provider: string | null;
  stt_provider_config: ProviderConfig;

  // AI Voice Agent
  ai_voice_agent_enabled: boolean;
  ai_voice_agent_llm_provider: string;
  ai_voice_agent_llm_config: ProviderConfig;
  ai_voice_agent_greeting: string | null;

  // LiveKit Override
  livekit_host: string | null;
  livekit_api_key: string | null;
  livekit_api_secret: string | null;
}

// Every field on the page, with sane defaults for an org that hasn't saved
// anything yet. Mirrored against banter_settings column defaults.
const DEFAULT_SETTINGS: AdminSettings = {
  voice_video_enabled: false,
  max_call_participants: 50,
  max_call_duration_minutes: 480,
  allow_recording: false,
  recording_storage_prefix: '',
  transcription_enabled: false,
  stt_provider: null,
  stt_provider_config: {},
  ai_voice_agent_enabled: false,
  ai_voice_agent_llm_provider: 'anthropic',
  ai_voice_agent_llm_config: {},
  ai_voice_agent_greeting: null,
  livekit_host: null,
  livekit_api_key: null,
  livekit_api_secret: null,
};

const STT_PROVIDER_OPTIONS = [
  { value: '', label: 'None / use platform default' },
  { value: 'assemblyai', label: 'AssemblyAI' },
  { value: 'deepgram', label: 'Deepgram' },
  { value: 'openai', label: 'OpenAI Whisper API' },
  { value: 'anthropic-whisper', label: 'Anthropic (Whisper-compatible)' },
];

const LLM_PROVIDER_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
];

/**
 * A value returned by the API is "masked" if it begins with at least one `*`.
 * We use this to decide whether the secret input is showing a server-supplied
 * placeholder (don't send it back unchanged) or a fresh value the user typed
 * (send it).
 */
function isMaskedSecret(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('*');
}

export function AdminCallingSettingsPage({ onNavigate }: AdminCallingSettingsPageProps) {
  const canEdit = useCan('banter.admin_setting.update');

  const [initial, setInitial] = useState<AdminSettings>(DEFAULT_SETTINGS);
  const [settings, setSettings] = useState<AdminSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track which secret fields the user has explicitly chosen to replace.
  // Only fields in this set are sent on save.
  const [secretReplaceMode, setSecretReplaceMode] = useState<Record<string, boolean>>({});
  // Per-section "advanced JSON" toggle.
  const [sttJsonMode, setSttJsonMode] = useState(false);
  const [llmJsonMode, setLlmJsonMode] = useState(false);
  const [sttJsonText, setSttJsonText] = useState('{}');
  const [llmJsonText, setLlmJsonText] = useState('{}');
  const [sttJsonError, setSttJsonError] = useState<string | null>(null);
  const [llmJsonError, setLlmJsonError] = useState<string | null>(null);

  useEffect(() => {
    if (!canEdit) {
      setLoading(false);
      return;
    }
    api
      .get<{ data: Partial<AdminSettings> }>('/admin/settings')
      .then((res) => {
        const merged: AdminSettings = { ...DEFAULT_SETTINGS, ...res.data };
        setInitial(merged);
        setSettings(merged);
        setSttJsonText(JSON.stringify(merged.stt_provider_config ?? {}, null, 2));
        setLlmJsonText(JSON.stringify(merged.ai_voice_agent_llm_config ?? {}, null, 2));
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) {
          // Server-side gate disagreed with the client-side gate; surface it.
          setError('You do not have permission to view org calling settings.');
        }
        // Otherwise fall back to defaults — likely a fresh org with no row yet.
      })
      .finally(() => setLoading(false));
  }, [canEdit]);

  /**
   * Compute the patch body: only changed keys, and never re-send a masked
   * secret. Secrets are only included when the user clicked Replace and
   * typed a non-empty, non-masked value.
   */
  const patchBody = useMemo(() => {
    const body: Partial<AdminSettings> = {};
    const keys = Object.keys(settings) as (keyof AdminSettings)[];

    for (const k of keys) {
      const current = settings[k];
      const original = initial[k];

      // Secret handling
      if (k === 'livekit_api_secret' || k === 'livekit_api_key' || k === 'livekit_host') {
        if (k === 'livekit_host') {
          // Not a secret — host is plaintext, compare directly
          if (current !== original) {
            (body as Record<string, unknown>)[k] = current === '' ? null : current;
          }
          continue;
        }
        // For secrets: only include if user explicitly entered replace mode
        // AND the current value isn't the masked placeholder AND it differs.
        if (
          secretReplaceMode[k] &&
          typeof current === 'string' &&
          current.length > 0 &&
          !isMaskedSecret(current)
        ) {
          (body as Record<string, unknown>)[k] = current;
        }
        continue;
      }

      // Plain comparison — objects and arrays compared by JSON stringify
      // for stable change detection on the provider_config records.
      const a = typeof current === 'object' ? JSON.stringify(current) : current;
      const b = typeof original === 'object' ? JSON.stringify(original) : original;
      if (a !== b) {
        (body as Record<string, unknown>)[k] = current;
      }
    }

    return body;
  }, [settings, initial, secretReplaceMode]);

  const hasChanges = Object.keys(patchBody).length > 0;

  const handleSave = async () => {
    setSaving(true);
    setSaveOk(false);
    setError(null);
    try {
      // Validate any open JSON editors first so we don't half-save.
      if (sttJsonMode && sttJsonError) {
        throw new Error(`STT config JSON is invalid: ${sttJsonError}`);
      }
      if (llmJsonMode && llmJsonError) {
        throw new Error(`LLM config JSON is invalid: ${llmJsonError}`);
      }

      const res = await api.patch<{ data: Partial<AdminSettings> }>(
        '/admin/settings',
        patchBody,
      );
      const merged: AdminSettings = { ...DEFAULT_SETTINGS, ...res.data };
      setInitial(merged);
      setSettings(merged);
      setSecretReplaceMode({});
      setSttJsonText(JSON.stringify(merged.stt_provider_config ?? {}, null, 2));
      setLlmJsonText(JSON.stringify(merged.ai_voice_agent_llm_config ?? {}, null, 2));
      setSaveOk(true);
      // Auto-clear the success indicator after a few seconds so it acts like
      // a toast even without a toast library wired up.
      setTimeout(() => setSaveOk(false), 4000);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`${err.code}: ${err.message}`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to save calling settings');
      }
    } finally {
      setSaving(false);
    }
  };

  const update = <K extends keyof AdminSettings>(key: K, value: AdminSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const updateProviderConfigField = (
    section: 'stt_provider_config' | 'ai_voice_agent_llm_config',
    field: string,
    value: string,
  ) => {
    setSettings((prev) => {
      const next = { ...(prev[section] as ProviderConfig) };
      if (value === '') delete next[field];
      else next[field] = value;
      return { ...prev, [section]: next };
    });
  };

  // ── Access gate ────────────────────────────────────────────────
  if (!canEdit && !loading) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Calling Settings" onBack={() => onNavigate('/channels/general')} />
        <div className="flex-1 flex items-center justify-center">
          <div className="max-w-md mx-auto px-6 py-8 text-center">
            <AlertCircle className="h-10 w-10 text-amber-500 mx-auto mb-3" />
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
              Org admin access required
            </h3>
            <p className="text-sm text-zinc-500">
              Calling settings can only be changed by an organization admin or owner. Ask
              your admin to grant the <code>banter.admin_setting.update</code> permission.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Calling Settings" onBack={() => onNavigate('/channels/general')} />

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-2xl mx-auto px-6 py-6 space-y-8 pb-24">
          {/* ── Voice & Video ────────────────────────────────────── */}
          <Section icon={<Video className="h-5 w-5" />} title="Voice & Video">
            <ToggleField
              label="Enable voice & video calls"
              description="Master switch for this org. When off, /channels/:id/calls returns 403."
              checked={settings.voice_video_enabled}
              onChange={(v) => update('voice_video_enabled', v)}
            />
            <InputField
              label="Maximum participants per call"
              description="Between 2 and 500. LiveKit-side limits also apply."
              type="number"
              value={String(settings.max_call_participants)}
              onChange={(v) =>
                update('max_call_participants', Math.max(2, Math.min(500, parseInt(v, 10) || 50)))
              }
            />
            <InputField
              label="Maximum call duration (minutes)"
              description="Calls beyond this are auto-ended. Default 480 (8 hours)."
              type="number"
              value={String(settings.max_call_duration_minutes)}
              onChange={(v) =>
                update('max_call_duration_minutes', Math.max(1, parseInt(v, 10) || 480))
              }
            />
          </Section>

          {/* ── Recording ────────────────────────────────────────── */}
          <Section icon={<Disc className="h-5 w-5" />} title="Recording">
            <ToggleField
              label="Allow call recording"
              description="When on, hosts see a Record button. Requires LiveKit Egress + S3."
              checked={settings.allow_recording}
              onChange={(v) => update('allow_recording', v)}
            />
            <InputField
              label="Recording storage prefix"
              description="Prepended to every recording's object key in S3/MinIO."
              placeholder="banter-recordings/"
              value={settings.recording_storage_prefix}
              onChange={(v) => update('recording_storage_prefix', v)}
            />
          </Section>

          {/* ── Transcription ────────────────────────────────────── */}
          <Section icon={<FileText className="h-5 w-5" />} title="Transcription">
            <ToggleField
              label="Enable live transcription"
              description="Generates banter_call_transcripts rows while a call is in progress."
              checked={settings.transcription_enabled}
              onChange={(v) => update('transcription_enabled', v)}
            />
            <SelectField
              label="STT provider"
              value={settings.stt_provider ?? ''}
              onChange={(v) => update('stt_provider', v === '' ? null : v)}
              options={STT_PROVIDER_OPTIONS}
            />

            <ProviderConfigEditor
              jsonMode={sttJsonMode}
              onToggleJson={() => {
                if (!sttJsonMode) {
                  setSttJsonText(JSON.stringify(settings.stt_provider_config ?? {}, null, 2));
                  setSttJsonError(null);
                }
                setSttJsonMode((v) => !v);
              }}
              jsonText={sttJsonText}
              onJsonTextChange={(text) => {
                setSttJsonText(text);
                try {
                  const parsed = JSON.parse(text);
                  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    setSttJsonError(null);
                    update('stt_provider_config', parsed as ProviderConfig);
                  } else {
                    setSttJsonError('Must be a JSON object');
                  }
                } catch (e) {
                  setSttJsonError((e as Error).message);
                }
              }}
              jsonError={sttJsonError}
              config={settings.stt_provider_config}
              fields={[
                { key: 'api_key', label: 'API key', type: 'password', isSecret: true },
                { key: 'model', label: 'Model', placeholder: 'e.g. nova-2, whisper-1' },
                { key: 'endpoint_url', label: 'Endpoint URL (optional)', placeholder: 'https://…' },
              ]}
              onChangeField={(field, value) =>
                updateProviderConfigField('stt_provider_config', field, value)
              }
            />
          </Section>

          {/* ── AI Voice Agent ───────────────────────────────────── */}
          <Section icon={<Bot className="h-5 w-5" />} title="AI Voice Agent">
            <ToggleField
              label="Enable AI voice agent"
              description="Allows the voice-agent service to join calls in this org."
              checked={settings.ai_voice_agent_enabled}
              onChange={(v) => update('ai_voice_agent_enabled', v)}
            />
            <SelectField
              label="LLM provider"
              value={settings.ai_voice_agent_llm_provider}
              onChange={(v) => update('ai_voice_agent_llm_provider', v)}
              options={LLM_PROVIDER_OPTIONS}
            />

            <ProviderConfigEditor
              jsonMode={llmJsonMode}
              onToggleJson={() => {
                if (!llmJsonMode) {
                  setLlmJsonText(
                    JSON.stringify(settings.ai_voice_agent_llm_config ?? {}, null, 2),
                  );
                  setLlmJsonError(null);
                }
                setLlmJsonMode((v) => !v);
              }}
              jsonText={llmJsonText}
              onJsonTextChange={(text) => {
                setLlmJsonText(text);
                try {
                  const parsed = JSON.parse(text);
                  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    setLlmJsonError(null);
                    update('ai_voice_agent_llm_config', parsed as ProviderConfig);
                  } else {
                    setLlmJsonError('Must be a JSON object');
                  }
                } catch (e) {
                  setLlmJsonError((e as Error).message);
                }
              }}
              jsonError={llmJsonError}
              config={settings.ai_voice_agent_llm_config}
              fields={[
                { key: 'api_key', label: 'API key', type: 'password', isSecret: true },
                {
                  key: 'model',
                  label: 'Model',
                  placeholder:
                    settings.ai_voice_agent_llm_provider === 'anthropic'
                      ? 'claude-sonnet-4-20250514'
                      : 'gpt-4o',
                },
              ]}
              onChangeField={(field, value) =>
                updateProviderConfigField('ai_voice_agent_llm_config', field, value)
              }
            />

            <InputField
              label="Greeting message"
              description="Spoken by the agent on join. Keep under 200 characters."
              placeholder="Hello! I'm the voice agent. How can I help?"
              value={settings.ai_voice_agent_greeting ?? ''}
              onChange={(v) => update('ai_voice_agent_greeting', v === '' ? null : v)}
            />
          </Section>

          {/* ── LiveKit Override ─────────────────────────────────── */}
          <Section icon={<Server className="h-5 w-5" />} title="LiveKit Override">
            <p className="text-xs text-zinc-500 dark:text-zinc-400 -mt-2 mb-2">
              Leave these empty to use the platform default LiveKit cluster. Set any of
              them to bring your own LiveKit (e.g. LiveKit Cloud). URLs are SSRF-guarded
              by the API. Secrets are stored encrypted and only the last 4 characters are
              ever returned.
            </p>

            <InputField
              label="LiveKit host"
              description="Public WSS URL. Empty = use platform default."
              placeholder="wss://livekit.example.com"
              value={settings.livekit_host ?? ''}
              onChange={(v) => update('livekit_host', v === '' ? null : v)}
            />

            <SecretField
              label="LiveKit API key"
              placeholder="APIxxxxxxxx"
              value={settings.livekit_api_key ?? ''}
              isReplaceMode={!!secretReplaceMode.livekit_api_key}
              onReplace={() => {
                setSecretReplaceMode((m) => ({ ...m, livekit_api_key: true }));
                update('livekit_api_key', '');
              }}
              onCancelReplace={() => {
                setSecretReplaceMode((m) => ({ ...m, livekit_api_key: false }));
                update('livekit_api_key', initial.livekit_api_key);
              }}
              onChange={(v) => update('livekit_api_key', v)}
            />

            <SecretField
              label="LiveKit API secret"
              placeholder="Enter secret..."
              value={settings.livekit_api_secret ?? ''}
              isReplaceMode={!!secretReplaceMode.livekit_api_secret}
              onReplace={() => {
                setSecretReplaceMode((m) => ({ ...m, livekit_api_secret: true }));
                update('livekit_api_secret', '');
              }}
              onCancelReplace={() => {
                setSecretReplaceMode((m) => ({ ...m, livekit_api_secret: false }));
                update('livekit_api_secret', initial.livekit_api_secret);
              }}
              onChange={(v) => update('livekit_api_secret', v)}
            />
          </Section>
        </div>
      </div>

      {/* Sticky save bar */}
      <div className="border-t border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-6 py-3 flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-colors',
            'bg-primary-600 text-white hover:bg-primary-700',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? 'Saving...' : hasChanges ? 'Save changes' : 'No changes'}
        </button>

        {saveOk && (
          <span className="flex items-center gap-1 text-sm text-green-600">
            <CheckCircle className="h-4 w-4" />
            Settings saved
          </span>
        )}
        {error && (
          <span className="flex items-center gap-1 text-sm text-red-600">
            <AlertCircle className="h-4 w-4" />
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Building blocks ──────────────────────────────────────────────

function PageHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="flex items-center gap-3 px-6 h-14 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
    </header>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-4 text-zinc-500">
        {icon}
        <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
      </div>
      <div className="space-y-4 pl-7">{children}</div>
    </section>
  );
}

function InputField({
  label,
  description,
  placeholder,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  description?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
        {label}
      </label>
      {description && <p className="text-xs text-zinc-500 mb-1">{description}</p>}
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full px-3 py-2 rounded-md text-sm',
          'border border-zinc-300 dark:border-zinc-600',
          'bg-white dark:bg-zinc-800',
          'text-zinc-900 dark:text-zinc-100',
          'placeholder:text-zinc-400',
          'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
        )}
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full px-3 py-2 rounded-md text-sm',
          'border border-zinc-300 dark:border-zinc-600',
          'bg-white dark:bg-zinc-800',
          'text-zinc-900 dark:text-zinc-100',
          'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
        )}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleField({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
          checked ? 'bg-primary-600' : 'bg-zinc-300 dark:bg-zinc-600',
        )}
      >
        <span
          className={cn(
            'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </button>
      <div>
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
        {description && <p className="text-xs text-zinc-500 mt-0.5">{description}</p>}
      </div>
    </div>
  );
}

/**
 * Secret field with masked display + explicit "Replace" affordance.
 * The user must click Replace before they can type a new value. This
 * keeps the masked placeholder from being accidentally re-sent and lets
 * the page distinguish "no change" from "user typed an empty string".
 */
function SecretField({
  label,
  placeholder,
  value,
  isReplaceMode,
  onReplace,
  onCancelReplace,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  isReplaceMode: boolean;
  onReplace: () => void;
  onCancelReplace: () => void;
  onChange: (value: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const looksMasked = isMaskedSecret(value);
  const isConfiguredOnServer = looksMasked && !isReplaceMode;

  return (
    <div>
      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type={reveal || isReplaceMode ? 'text' : 'password'}
            placeholder={isReplaceMode ? placeholder : isConfiguredOnServer ? '' : 'Not set — use platform default'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            readOnly={!isReplaceMode && looksMasked}
            className={cn(
              'w-full px-3 py-2 rounded-md text-sm pr-9',
              'border border-zinc-300 dark:border-zinc-600',
              'bg-white dark:bg-zinc-800',
              'text-zinc-900 dark:text-zinc-100',
              'placeholder:text-zinc-400',
              'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
              !isReplaceMode && looksMasked && 'cursor-not-allowed',
            )}
          />
          {isReplaceMode && (
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              title={reveal ? 'Hide' : 'Reveal'}
            >
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
        {isReplaceMode ? (
          <button
            type="button"
            onClick={onCancelReplace}
            className="px-3 py-2 text-xs rounded-md border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={onReplace}
            className="flex items-center gap-1 px-3 py-2 text-xs rounded-md border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            <RefreshCw className="h-3 w-3" />
            Replace
          </button>
        )}
      </div>
      {isConfiguredOnServer && (
        <p className="text-xs text-zinc-500 mt-1">
          Configured (masked). Click Replace to set a new value.
        </p>
      )}
    </div>
  );
}

interface ConfigFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  type?: string;
  isSecret?: boolean;
}

/**
 * Provider config editor with two modes:
 * - Structured: known fields (api_key, model, endpoint_url, …) as labelled inputs.
 * - Advanced JSON: raw textarea for arbitrary provider knobs.
 *
 * The two views stay in sync via the parent's settings state. Switching modes
 * does not lose unsaved field values.
 */
function ProviderConfigEditor({
  jsonMode,
  onToggleJson,
  jsonText,
  onJsonTextChange,
  jsonError,
  config,
  fields,
  onChangeField,
}: {
  jsonMode: boolean;
  onToggleJson: () => void;
  jsonText: string;
  onJsonTextChange: (text: string) => void;
  jsonError: string | null;
  config: ProviderConfig;
  fields: ConfigFieldSpec[];
  onChangeField: (field: string, value: string) => void;
}) {
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-700 p-3 bg-zinc-50 dark:bg-zinc-800/30">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Provider config
        </span>
        <button
          type="button"
          onClick={onToggleJson}
          className="text-xs text-primary-600 hover:underline"
        >
          {jsonMode ? 'Use structured form' : 'Advanced (JSON)'}
        </button>
      </div>

      {jsonMode ? (
        <div>
          <textarea
            value={jsonText}
            onChange={(e) => onJsonTextChange(e.target.value)}
            rows={6}
            spellCheck={false}
            className={cn(
              'w-full px-3 py-2 rounded-md text-xs font-mono',
              'border border-zinc-300 dark:border-zinc-600',
              'bg-white dark:bg-zinc-900',
              'text-zinc-900 dark:text-zinc-100',
              'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
            )}
          />
          {jsonError && (
            <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {jsonError}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {fields.map((f) => {
            const raw = config?.[f.key];
            const value = typeof raw === 'string' ? raw : '';
            const masked = f.isSecret && isMaskedSecret(value);
            return (
              <InputField
                key={f.key}
                label={f.label}
                placeholder={f.placeholder}
                type={f.type ?? 'text'}
                value={masked ? '' : value}
                onChange={(v) => onChangeField(f.key, v)}
              />
            );
          })}
          {fields.some((f) => f.isSecret && isMaskedSecret(typeof config?.[f.key] === 'string' ? (config[f.key] as string) : '')) && (
            <p className="text-xs text-zinc-500">
              Existing secret is masked on the server. Type a new value to replace it; leave blank to keep the stored secret.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
