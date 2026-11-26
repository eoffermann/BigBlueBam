import { useState, useEffect } from 'react';
import { ArrowLeft, Video, MessageSquare, Bot, Hash, Save, Loader2, CheckCircle, AlertCircle, Mic, Volume2, Brain } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface AdminPageProps {
  onNavigate: (path: string) => void;
}

interface ProviderConfig {
  api_key?: string;
  model?: string;
  endpoint_url?: string;
}

interface TtsProviderConfig {
  api_key?: string;
  voice?: string;
  endpoint_url?: string;
}

interface LlmConfig {
  api_key?: string;
  model?: string;
}

interface AdminSettings {
  // Voice & Video
  voice_video_enabled: boolean;
  livekit_host: string;
  livekit_api_key: string;
  livekit_api_secret: string;

  // Channel settings
  default_channel: string;
  allow_channel_creation: 'everyone' | 'admins' | 'org_owners';

  // Message settings
  message_retention_days: number;
  max_file_size_mb: number;

  // AI settings
  voice_agent_enabled: boolean;
  stt_provider: string;
  stt_provider_config: ProviderConfig;
  tts_provider: string;
  tts_provider_config: TtsProviderConfig;
  ai_voice_agent_llm_provider: string;
  ai_voice_agent_llm_config: LlmConfig;
  ai_voice_agent_greeting: string;
}

const DEFAULT_SETTINGS: AdminSettings = {
  voice_video_enabled: false,
  livekit_host: '',
  livekit_api_key: '',
  livekit_api_secret: '',
  default_channel: 'general',
  allow_channel_creation: 'everyone',
  message_retention_days: 0,
  max_file_size_mb: 25,
  voice_agent_enabled: false,
  stt_provider: 'none',
  stt_provider_config: {},
  tts_provider: 'none',
  tts_provider_config: {},
  ai_voice_agent_llm_provider: 'anthropic',
  ai_voice_agent_llm_config: {},
  ai_voice_agent_greeting: '',
};

export function AdminPage({ onNavigate }: AdminPageProps) {
  const [settings, setSettings] = useState<AdminSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testingLiveKit, setTestingLiveKit] = useState(false);
  const [liveKitStatus, setLiveKitStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [testingStt, setTestingStt] = useState(false);
  const [sttStatus, setSttStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [testingTts, setTestingTts] = useState(false);
  const [ttsStatus, setTtsStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [voiceAgentOnline, setVoiceAgentOnline] = useState<boolean | null>(null);
  const [syncingConfig, setSyncingConfig] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // TODO: wire up checkVoiceAgentStatus() when the voice-agent /config
  // proxy endpoint is available. Removed the dead callback to keep
  // noUnusedLocals happy.

  const handleSyncConfig = async () => {
    setSyncingConfig(true);
    setSyncStatus('idle');
    try {
      await api.post('/admin/settings/push-voice-config', {});
      setSyncStatus('success');
      setVoiceAgentOnline(true);
      setTimeout(() => setSyncStatus('idle'), 5000);
    } catch {
      setSyncStatus('error');
      setVoiceAgentOnline(false);
      setTimeout(() => setSyncStatus('idle'), 5000);
    } finally {
      setSyncingConfig(false);
    }
  };

  useEffect(() => {
    api
      .get<{ data: AdminSettings }>('/admin/settings')
      .then((res) => {
        setSettings({ ...DEFAULT_SETTINGS, ...res.data });
      })
      .catch(() => {
        // Use defaults if settings haven't been configured yet
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch('/admin/settings', settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleTestLiveKit = async () => {
    setTestingLiveKit(true);
    setLiveKitStatus('idle');
    try {
      await api.post('/admin/settings/test-livekit', {
        host: settings.livekit_host,
        api_key: settings.livekit_api_key,
        api_secret: settings.livekit_api_secret,
      });
      setLiveKitStatus('success');
    } catch {
      setLiveKitStatus('error');
    } finally {
      setTestingLiveKit(false);
      setTimeout(() => setLiveKitStatus('idle'), 5000);
    }
  };

  const handleTestStt = async () => {
    setTestingStt(true);
    setSttStatus('idle');
    try {
      await api.post('/admin/settings/test-stt', {
        provider: settings.stt_provider,
        config: settings.stt_provider_config,
      });
      setSttStatus('success');
    } catch {
      setSttStatus('error');
    } finally {
      setTestingStt(false);
      setTimeout(() => setSttStatus('idle'), 5000);
    }
  };

  const handleTestTts = async () => {
    setTestingTts(true);
    setTtsStatus('idle');
    try {
      await api.post('/admin/settings/test-tts', {
        provider: settings.tts_provider,
        config: settings.tts_provider_config,
      });
      setTtsStatus('success');
    } catch {
      setTtsStatus('error');
    } finally {
      setTestingTts(false);
      setTimeout(() => setTtsStatus('idle'), 5000);
    }
  };

  const updateSttConfig = (field: keyof ProviderConfig, value: string) => {
    setSettings((prev) => ({
      ...prev,
      stt_provider_config: { ...prev.stt_provider_config, [field]: value },
    }));
  };

  const updateTtsConfig = (field: keyof TtsProviderConfig, value: string) => {
    setSettings((prev) => ({
      ...prev,
      tts_provider_config: { ...prev.tts_provider_config, [field]: value },
    }));
  };

  const updateLlmConfig = (field: keyof LlmConfig, value: string) => {
    setSettings((prev) => ({
      ...prev,
      ai_voice_agent_llm_config: { ...prev.ai_voice_agent_llm_config, [field]: value },
    }));
  };

  const update = <K extends keyof AdminSettings>(key: K, value: AdminSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 h-14 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
        <button
          onClick={() => onNavigate('/channels/general')}
          className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Banter Administration
        </h2>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-6 space-y-8">
          {/* Voice & Video Section */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Video className="h-5 w-5 text-zinc-500" />
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                Voice & Video
              </h3>
            </div>

            <div className="space-y-4 pl-7">
              <ToggleField
                label="Enable voice & video calls"
                description="Requires a LiveKit server to be configured"
                checked={settings.voice_video_enabled}
                onChange={(v) => update('voice_video_enabled', v)}
              />

              {settings.voice_video_enabled && (
                <>
                  <InputField
                    label="LiveKit Host"
                    placeholder="wss://livekit.example.com"
                    value={settings.livekit_host}
                    onChange={(v) => update('livekit_host', v)}
                  />
                  <InputField
                    label="LiveKit API Key"
                    placeholder="APIxxxxxxxx"
                    value={settings.livekit_api_key}
                    onChange={(v) => update('livekit_api_key', v)}
                  />
                  <InputField
                    label="LiveKit API Secret"
                    placeholder="Enter secret..."
                    value={settings.livekit_api_secret}
                    onChange={(v) => update('livekit_api_secret', v)}
                    type="password"
                  />

                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleTestLiveKit}
                      disabled={testingLiveKit || !settings.livekit_host}
                      className={cn(
                        'px-3 py-1.5 text-sm rounded-md font-medium transition-colors',
                        'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300',
                        'hover:bg-zinc-200 dark:hover:bg-zinc-700',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                      )}
                    >
                      {testingLiveKit ? (
                        <span className="flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Testing...
                        </span>
                      ) : (
                        'Test Connection'
                      )}
                    </button>
                    {liveKitStatus === 'success' && (
                      <span className="flex items-center gap-1 text-sm text-green-600">
                        <CheckCircle className="h-4 w-4" />
                        Connected
                      </span>
                    )}
                    {liveKitStatus === 'error' && (
                      <span className="flex items-center gap-1 text-sm text-red-600">
                        <AlertCircle className="h-4 w-4" />
                        Connection failed
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </section>

          <hr className="border-zinc-200 dark:border-zinc-700" />

          {/* Channel Settings */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Hash className="h-5 w-5 text-zinc-500" />
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                Channel Settings
              </h3>
            </div>

            <div className="space-y-4 pl-7">
              <InputField
                label="Default Channel"
                placeholder="general"
                value={settings.default_channel}
                onChange={(v) => update('default_channel', v)}
              />

              <SelectField
                label="Who can create channels"
                value={settings.allow_channel_creation}
                onChange={(v) => update('allow_channel_creation', v as AdminSettings['allow_channel_creation'])}
                options={[
                  { value: 'everyone', label: 'Everyone' },
                  { value: 'admins', label: 'Admins only' },
                  { value: 'org_owners', label: 'Organization owners only' },
                ]}
              />
            </div>
          </section>

          <hr className="border-zinc-200 dark:border-zinc-700" />

          {/* Message Settings */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <MessageSquare className="h-5 w-5 text-zinc-500" />
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                Message Settings
              </h3>
            </div>

            <div className="space-y-4 pl-7">
              <InputField
                label="Message retention (days)"
                description="0 = keep forever"
                placeholder="0"
                value={String(settings.message_retention_days)}
                onChange={(v) => update('message_retention_days', Number.parseInt(v, 10) || 0)}
                type="number"
              />

              <InputField
                label="Max file upload size (MB)"
                placeholder="25"
                value={String(settings.max_file_size_mb)}
                onChange={(v) => update('max_file_size_mb', Number.parseInt(v, 10) || 25)}
                type="number"
              />
            </div>
          </section>

          <hr className="border-zinc-200 dark:border-zinc-700" />

          {/* AI Settings */}
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Bot className="h-5 w-5 text-zinc-500" />
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                AI & Voice Agent
              </h3>
            </div>

            <div className="space-y-4 pl-7">
              {/* Provider Status Overview */}
              <div className="grid grid-cols-2 gap-2 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/30">
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn('h-2 w-2 rounded-full', voiceAgentOnline ? 'bg-green-500' : 'bg-red-500')} />
                  <span className="text-zinc-600 dark:text-zinc-400">Voice Agent: {voiceAgentOnline ? 'Online' : 'Offline'}</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn('h-2 w-2 rounded-full', settings.stt_provider !== 'none' ? 'bg-green-500' : 'bg-zinc-400')} />
                  <span className="text-zinc-600 dark:text-zinc-400">STT: {settings.stt_provider !== 'none' ? settings.stt_provider : 'Not configured'}</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn('h-2 w-2 rounded-full', settings.tts_provider !== 'none' ? 'bg-green-500' : 'bg-zinc-400')} />
                  <span className="text-zinc-600 dark:text-zinc-400">TTS: {settings.tts_provider !== 'none' ? settings.tts_provider : 'Not configured'}</span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn('h-2 w-2 rounded-full', settings.ai_voice_agent_llm_provider ? 'bg-green-500' : 'bg-zinc-400')} />
                  <span className="text-zinc-600 dark:text-zinc-400">LLM: {settings.ai_voice_agent_llm_provider || 'Not configured'}</span>
                </div>
              </div>

              {/* Sync config to voice agent */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleSyncConfig}
                  disabled={syncingConfig}
                  className={cn(
                    'px-3 py-1.5 text-sm rounded-md font-medium transition-colors',
                    'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300',
                    'hover:bg-zinc-200 dark:hover:bg-zinc-700',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                  )}
                >
                  {syncingConfig ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Syncing...
                    </span>
                  ) : (
                    'Sync Configuration to Voice Agent'
                  )}
                </button>
                {syncStatus === 'success' && (
                  <span className="flex items-center gap-1 text-sm text-green-600">
                    <CheckCircle className="h-4 w-4" /> Synced
                  </span>
                )}
                {syncStatus === 'error' && (
                  <span className="flex items-center gap-1 text-sm text-red-600">
                    <AlertCircle className="h-4 w-4" /> Voice agent unreachable
                  </span>
                )}
              </div>

              <ToggleField
                label="Enable voice agent"
                description="Allow AI agents to participate in calls with spoken audio"
                checked={settings.voice_agent_enabled}
                onChange={(v) => update('voice_agent_enabled', v)}
              />

              {settings.voice_agent_enabled && (
                <>
                  <InputField
                    label="Voice Agent Greeting"
                    description="The greeting message the agent says when joining a call"
                    placeholder="Hello! I'm the voice agent. How can I help?"
                    value={settings.ai_voice_agent_greeting}
                    onChange={(v) => update('ai_voice_agent_greeting', v)}
                  />

                  {/* STT Provider */}
                  <div className="flex items-center gap-2 mt-6 mb-2">
                    <Mic className="h-4 w-4 text-zinc-500" />
                    <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                      Speech-to-Text
                    </span>
                    <StatusBadge status={settings.stt_provider !== 'none' ? sttStatus : 'idle'} configured={settings.stt_provider !== 'none'} />
                  </div>
                  <p className="text-xs text-zinc-500 mb-2">
                    Self-hosted: Whisper (requires GPU container, ~200ms latency). Cloud: Deepgram (~300ms), Google Cloud Speech (~400ms), OpenAI Whisper API (~500ms).
                  </p>

                  <div className="text-xs text-zinc-500 dark:text-zinc-400 space-y-1 -mt-1 mb-1">
                    <p><span className="font-medium">Self-hosted:</span> Whisper (requires GPU Docker container) ~200ms latency</p>
                    <p><span className="font-medium">Cloud:</span> Deepgram, Google Cloud Speech, OpenAI Whisper API ~300-500ms latency</p>
                  </div>

                  <SelectField
                    label="STT Provider"
                    value={settings.stt_provider}
                    onChange={(v) => update('stt_provider', v)}
                    options={[
                      { value: 'none', label: 'None (text-only mode)' },
                      { value: 'whisper', label: 'Whisper (self-hosted)' },
                      { value: 'deepgram', label: 'Deepgram' },
                      { value: 'google', label: 'Google Cloud STT' },
                      { value: 'openai', label: 'OpenAI Whisper API' },
                    ]}
                  />

                  {settings.stt_provider !== 'none' && settings.stt_provider !== 'whisper' && (
                    <>
                      <InputField
                        label="STT API Key"
                        placeholder="Enter API key..."
                        value={settings.stt_provider_config.api_key ?? ''}
                        onChange={(v) => updateSttConfig('api_key', v)}
                        type="password"
                      />
                      <InputField
                        label="STT Model"
                        placeholder="e.g. whisper-1, nova-2"
                        value={settings.stt_provider_config.model ?? ''}
                        onChange={(v) => updateSttConfig('model', v)}
                      />
                      <InputField
                        label="STT Endpoint URL"
                        description="Leave blank to use the provider's default endpoint"
                        placeholder="https://api.example.com/v1/transcribe"
                        value={settings.stt_provider_config.endpoint_url ?? ''}
                        onChange={(v) => updateSttConfig('endpoint_url', v)}
                      />
                    </>
                  )}

                  {settings.stt_provider !== 'none' && (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleTestStt}
                        disabled={testingStt}
                        className={cn(
                          'px-3 py-1.5 text-sm rounded-md font-medium transition-colors',
                          'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300',
                          'hover:bg-zinc-200 dark:hover:bg-zinc-700',
                          'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                      >
                        {testingStt ? (
                          <span className="flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Testing...
                          </span>
                        ) : (
                          'Test STT'
                        )}
                      </button>
                      {sttStatus === 'success' && (
                        <span className="flex items-center gap-1 text-sm text-green-600">
                          <CheckCircle className="h-4 w-4" />
                          STT working
                        </span>
                      )}
                      {sttStatus === 'error' && (
                        <span className="flex items-center gap-1 text-sm text-red-600">
                          <AlertCircle className="h-4 w-4" />
                          STT test failed
                        </span>
                      )}
                    </div>
                  )}

                  {/* TTS Provider */}
                  <div className="flex items-center gap-2 mt-6 mb-2">
                    <Volume2 className="h-4 w-4 text-zinc-500" />
                    <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                      Text-to-Speech
                    </span>
                    <StatusBadge status={settings.tts_provider !== 'none' ? ttsStatus : 'idle'} configured={settings.tts_provider !== 'none'} />
                  </div>
                  <p className="text-xs text-zinc-500 mb-2">
                    Self-hosted: Piper (CPU ONNX models, ~150ms latency). Cloud: ElevenLabs (~300ms, high quality), Google Cloud TTS (~350ms), OpenAI TTS (~400ms).
                  </p>

                  <div className="text-xs text-zinc-500 dark:text-zinc-400 space-y-1 -mt-1 mb-1">
                    <p><span className="font-medium">Self-hosted:</span> Piper (CPU, ONNX models) ~200ms latency</p>
                    <p><span className="font-medium">Cloud:</span> ElevenLabs, Google Cloud TTS, OpenAI TTS ~300-500ms latency</p>
                  </div>

                  <SelectField
                    label="TTS Provider"
                    value={settings.tts_provider}
                    onChange={(v) => update('tts_provider', v)}
                    options={[
                      { value: 'none', label: 'None (text-only mode)' },
                      { value: 'piper', label: 'Piper (self-hosted)' },
                      { value: 'elevenlabs', label: 'ElevenLabs' },
                      { value: 'google', label: 'Google Cloud TTS' },
                      { value: 'openai', label: 'OpenAI TTS' },
                    ]}
                  />

                  {settings.tts_provider !== 'none' && settings.tts_provider !== 'piper' && (
                    <>
                      <InputField
                        label="TTS API Key"
                        placeholder="Enter API key..."
                        value={settings.tts_provider_config.api_key ?? ''}
                        onChange={(v) => updateTtsConfig('api_key', v)}
                        type="password"
                      />
                      <InputField
                        label="TTS Voice Name"
                        placeholder="e.g. alloy, rachel, en-US-Wavenet-D"
                        value={settings.tts_provider_config.voice ?? ''}
                        onChange={(v) => updateTtsConfig('voice', v)}
                      />
                      <InputField
                        label="TTS Endpoint URL"
                        description="Leave blank to use the provider's default endpoint"
                        placeholder="https://api.example.com/v1/tts"
                        value={settings.tts_provider_config.endpoint_url ?? ''}
                        onChange={(v) => updateTtsConfig('endpoint_url', v)}
                      />
                    </>
                  )}

                  {settings.tts_provider !== 'none' && (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handleTestTts}
                        disabled={testingTts}
                        className={cn(
                          'px-3 py-1.5 text-sm rounded-md font-medium transition-colors',
                          'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300',
                          'hover:bg-zinc-200 dark:hover:bg-zinc-700',
                          'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                      >
                        {testingTts ? (
                          <span className="flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Testing...
                          </span>
                        ) : (
                          'Test TTS'
                        )}
                      </button>
                      {ttsStatus === 'success' && (
                        <span className="flex items-center gap-1 text-sm text-green-600">
                          <CheckCircle className="h-4 w-4" />
                          TTS working
                        </span>
                      )}
                      {ttsStatus === 'error' && (
                        <span className="flex items-center gap-1 text-sm text-red-600">
                          <AlertCircle className="h-4 w-4" />
                          TTS test failed
                        </span>
                      )}
                    </div>
                  )}

                  {/* LLM Provider */}
                  <div className="flex items-center gap-2 mt-6 mb-2">
                    <Brain className="h-4 w-4 text-zinc-500" />
                    <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                      LLM Provider
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500 mb-2">
                    Claude Sonnet recommended for voice latency. Claude Opus for higher quality responses. OpenAI GPT-4o also supported.
                  </p>
                  <div className="flex items-center gap-2 mt-0 mb-0">
                    <StatusBadge
                      status="idle"
                      configured={!!settings.ai_voice_agent_llm_config.api_key}
                    />
                  </div>

                  <SelectField
                    label="LLM Provider"
                    value={settings.ai_voice_agent_llm_provider}
                    onChange={(v) => update('ai_voice_agent_llm_provider', v)}
                    options={[
                      { value: 'anthropic', label: 'Anthropic' },
                      { value: 'openai', label: 'OpenAI' },
                    ]}
                  />

                  <InputField
                    label="LLM API Key"
                    placeholder="Enter API key..."
                    value={settings.ai_voice_agent_llm_config.api_key ?? ''}
                    onChange={(v) => updateLlmConfig('api_key', v)}
                    type="password"
                  />

                  <InputField
                    label="LLM Model"
                    placeholder={
                      settings.ai_voice_agent_llm_provider === 'anthropic'
                        ? 'claude-sonnet-4-20250514'
                        : 'gpt-4o'
                    }
                    value={settings.ai_voice_agent_llm_config.model ?? ''}
                    onChange={(v) => updateLlmConfig('model', v)}
                  />

                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Claude Sonnet recommended for voice latency. Claude Opus for quality.
                  </p>
                </>
              )}
            </div>
          </section>

          {/* Save button */}
          <div className="flex items-center gap-3 pt-4 pb-8">
            <button
              onClick={handleSave}
              disabled={saving}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-colors',
                'bg-primary-600 text-white hover:bg-primary-700',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving ? 'Saving...' : 'Save Settings'}
            </button>

            {saved && (
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
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable field components
// ---------------------------------------------------------------------------

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
      {description && (
        <p className="text-xs text-zinc-500 mb-1">{description}</p>
      )}
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
        {description && (
          <p className="text-xs text-zinc-500 mt-0.5">{description}</p>
        )}
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  configured,
}: {
  status: 'idle' | 'success' | 'error';
  configured: boolean;
}) {
  if (status === 'success') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        OK
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        Error
      </span>
    );
  }
  if (configured) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        Configured
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" />
      Not configured
    </span>
  );
}
