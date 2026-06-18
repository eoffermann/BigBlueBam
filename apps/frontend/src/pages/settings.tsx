import { useState, useEffect } from 'react';
import { Moon, Sun, Monitor, User, Bell, Users, Trash2, Plug, Copy, Check, Plus, Headset, Pencil, Lock, Zap, Bot, RefreshCw, LayoutGrid, ListChecks, Info, KeyRound } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PaginatedResponse, ApiResponse, Project } from '@bigbluebam/shared';
import { AppLayout } from '@/components/layout/app-layout';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { useAuthStore } from '@/stores/auth.store';
import { useCan } from '@bigbluebam/ui/use-can';
import { api, ApiError } from '@/lib/api';
import { changePassword } from '@/lib/api/people';
import { formatDate } from '@/lib/utils';
import { SettingsLlmProviders } from '@/pages/settings-llm-providers';
import { OrgSmtpSettingsForm } from '@/components/settings/org-smtp-settings-form';
import { SlackImportCard } from '@/components/settings/slack-import-card';
import { PriorityManager } from '@/components/settings/priority-manager';
import { usePriorities, priorityInlineStyle } from '@/hooks/use-priorities';
import { timezoneSelectOptions } from '@/lib/timezones';
import { SettingsFtueTour, type SettingsTab } from '@/components/ftue/settings-tour';

/** Notification preference keys shown in the Notifications tab. */
const NOTIFICATION_PREFS: { key: string; label: string }[] = [
  { key: 'assigned', label: 'Task assigned to me' },
  { key: 'mentioned', label: 'Mentioned in comments' },
  { key: 'state_changed', label: 'Task state changed' },
  { key: 'sprint', label: 'Sprint started/completed' },
  { key: 'due_date', label: 'Due date approaching' },
];

interface ApiKeyData {
  id: string;
  name: string;
  key_prefix: string;
  key_hint: string;
  scope: string;
  project_ids: string[] | null;
  expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  key?: string; // only present on creation
}

interface ServiceAccountData {
  id: string;
  name: string;
  email: string;
  created_at: string;
  disabled_at: string | null;
  created_by: { id: string; display_name: string | null } | null;
  policy: { enabled: boolean; allowed_tool_count: number } | null;
  api_key: {
    id: string;
    name: string;
    key_hint: string;
    scope: string;
    project_ids: string[] | null;
    last_used_at: string | null;
    rotated_at: string | null;
  } | null;
}

interface ServiceAccountCreateResponse {
  data: {
    id: string;
    name: string;
    email: string;
    api_key: { id: string; name: string; key: string; key_prefix: string; scope: string; project_ids: string[] | null };
    policy: { enabled: boolean; allowed_tools: string[] };
  };
}

interface WebhookData {
  id: string;
  project_id: string;
  url: string;
  events: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface SlackIntegrationData {
  id: string;
  project_id: string;
  webhook_url: string;
  notify_on_task_created: boolean;
  notify_on_task_completed: boolean;
  notify_on_sprint_started: boolean;
  notify_on_sprint_completed: boolean;
  slash_command_token: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

const WEBHOOK_EVENT_TYPES = [
  'task.created',
  'task.updated',
  'task.deleted',
  'comment.created',
  'sprint.started',
  'sprint.completed',
];

interface SettingsPageProps {
  onNavigate: (path: string) => void;
  /** When true, render the first-time-user guided tour over this page. */
  ftue?: boolean;
  /** Called when the user finishes or skips the FTUE tour. */
  onFtueComplete?: () => void;
}

export function SettingsPage({ onNavigate, ftue = false, onFtueComplete }: SettingsPageProps) {
  const { user, patchUser } = useAuthStore();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'profile' | 'password' | 'appearance' | 'notifications' | 'members' | 'tasks' | 'integrations' | 'helpdesk' | 'permissions' | 'launchpad' | 'ai-providers'>('profile');
  const [priorityManagerOpen, setPriorityManagerOpen] = useState(false);
  const [displayName, setDisplayName] = useState(user?.display_name ?? '');
  const [timezone, setTimezone] = useState(user?.timezone ?? 'UTC');
  // Notification preferences, hydrated from the user's saved prefs (default on).
  const [notifPrefs, setNotifPrefs] = useState<Record<string, boolean>>(() => {
    const saved = (user?.notification_prefs ?? {}) as Record<string, unknown>;
    return Object.fromEntries(
      NOTIFICATION_PREFS.map(({ key }) => [key, saved[key] !== false]),
    );
  });
  const [savingNotif, setSavingNotif] = useState(false);
  const [savedNotif, setSavedNotif] = useState(false);
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
    return (localStorage.getItem('bbam-theme') as 'system' | 'light' | 'dark') ?? 'system';
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Password tab state (self-service change-password form)
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSubmitting, setPwSubmitting] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaved, setPwSaved] = useState(false);

  // Integrations tab state
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyScope, setNewKeyScope] = useState('read');
  const [createdKeyValue, setCreatedKeyValue] = useState<string | null>(null);
  // Service-account form state (Agents section)
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentScope, setNewAgentScope] = useState('read_write');
  const [newAgentProjectIds, setNewAgentProjectIds] = useState<string[]>([]);
  const [newAgentAllowedTools, setNewAgentAllowedTools] = useState('');
  const [createdAgentKey, setCreatedAgentKey] = useState<{ key: string; name: string } | null>(null);
  const [rotatedAgentKey, setRotatedAgentKey] = useState<{ key: string; name: string } | null>(null);
  const [agentMutationError, setAgentMutationError] = useState<string | null>(null);
  // #25: revoked agents stay in the list for audit but are hidden by default;
  // a "Show revoked" toggle reveals them rather than leaving dead rows cluttering
  // the table with no operator path.
  const [showRevokedAgents, setShowRevokedAgents] = useState(false);

  const [showAddWebhook, setShowAddWebhook] = useState<string | null>(null); // project id
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookEvents, setWebhookEvents] = useState<string[]>([]);
  const [editingWebhookId, setEditingWebhookId] = useState<string | null>(null);
  const [editWebhookUrl, setEditWebhookUrl] = useState('');
  const [editWebhookEvents, setEditWebhookEvents] = useState<string[]>([]);

  // Slack integration state (per project, editing one at a time)
  const [slackProjectId, setSlackProjectId] = useState<string>('');
  const [slackWebhookUrl, setSlackWebhookUrl] = useState('');
  const [slackToken, setSlackToken] = useState('');
  const [slackNotifyTaskCreated, setSlackNotifyTaskCreated] = useState(true);
  const [slackNotifyTaskCompleted, setSlackNotifyTaskCompleted] = useState(true);
  const [slackNotifySprintStarted, setSlackNotifySprintStarted] = useState(true);
  const [slackNotifySprintCompleted, setSlackNotifySprintCompleted] = useState(true);
  const [slackEnabled, setSlackEnabled] = useState(true);
  const [slackTestStatus, setSlackTestStatus] = useState<string | null>(null);

  // GitHub integration state (per project, editing one at a time)
  const [ghProjectId, setGhProjectId] = useState<string>('');
  const [ghRepoOwner, setGhRepoOwner] = useState('');
  const [ghRepoName, setGhRepoName] = useState('');
  const [ghOpenPhaseId, setGhOpenPhaseId] = useState<string>('');
  const [ghMergedPhaseId, setGhMergedPhaseId] = useState<string>('');
  const [ghEnabled, setGhEnabled] = useState(true);
  const [ghRevealedSecret, setGhRevealedSecret] = useState<string | null>(null);

  // Helpdesk tab state
  const [helpdeskRequireVerification, setHelpdeskRequireVerification] = useState(false);
  const [helpdeskAllowedDomains, setHelpdeskAllowedDomains] = useState('');
  const [helpdeskDefaultProject, setHelpdeskDefaultProject] = useState('');
  const [helpdeskDefaultPhase, setHelpdeskDefaultPhase] = useState('');
  const [helpdeskWelcomeMessage, setHelpdeskWelcomeMessage] = useState('');
  const [helpdeskCategories, setHelpdeskCategories] = useState('');
  const [helpdeskNotifyOnStatus, setHelpdeskNotifyOnStatus] = useState(true);
  const [helpdeskNotifyOnReply, setHelpdeskNotifyOnReply] = useState(true);
  const [helpdeskSaving, setHelpdeskSaving] = useState(false);
  const [helpdeskSaved, setHelpdeskSaved] = useState(false);

  // Fetch projects for integrations
  const { data: projectsRes } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<PaginatedResponse<Project>>('/projects'),
    enabled: activeTab === 'integrations',
  });
  const projects = projectsRes?.data ?? [];

  // Fetch API keys
  const { data: apiKeysRes } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get<{ data: ApiKeyData[] }>('/auth/api-keys'),
    enabled: activeTab === 'integrations',
  });
  const apiKeysData = apiKeysRes?.data ?? [];

  // Create API key mutation
  const createApiKey = useMutation({
    mutationFn: (data: { name: string; scope: string }) =>
      api.post<{ data: ApiKeyData }>('/auth/api-keys', data),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      setCreatedKeyValue(res.data.key ?? null);
      setNewKeyName('');
      setNewKeyScope('read');
      setShowCreateKey(false);
    },
  });

  // Revoke API key mutation
  const revokeApiKey = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/api-keys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  // ── Agents (service accounts) ──────────────────────────────────────
  const { data: agentsRes } = useQuery({
    queryKey: ['service-accounts'],
    queryFn: () => api.get<{ data: ServiceAccountData[] }>('/auth/service-accounts'),
    enabled: activeTab === 'integrations',
  });
  const agentsData = agentsRes?.data ?? [];

  const createAgent = useMutation({
    mutationFn: (payload: { name: string; scope: string; project_ids?: string[]; allowed_tools?: string[] }) =>
      api.post<ServiceAccountCreateResponse>('/auth/service-accounts', payload),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['service-accounts'] });
      setCreatedAgentKey({ key: res.data.api_key.key, name: res.data.name });
      setNewAgentName('');
      setNewAgentScope('read_write');
      setNewAgentProjectIds([]);
      setNewAgentAllowedTools('');
      setShowCreateAgent(false);
    },
    onError: (err) => {
      setAgentMutationError((err as Error).message);
    },
  });

  const revokeAgent = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/service-accounts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['service-accounts'] });
    },
    onError: (err) => {
      setAgentMutationError((err as Error).message);
    },
  });

  // #24: rotate is service-account-aware. The key is owned by the service
  // user, so the old user-scoped /auth/api-keys/:id/rotate matched zero rows
  // and 404'd silently (no onError). Point at the new endpoint with the agent
  // *user* id, and surface failures in the banner below.
  const rotateAgentKey = useMutation({
    mutationFn: (agentId: string) =>
      api.post<{ data: { key: string; name: string } }>(`/auth/service-accounts/${agentId}/rotate`),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['service-accounts'] });
      setRotatedAgentKey({ key: res.data.key, name: res.data.name });
    },
    onError: (err) => {
      setAgentMutationError((err as Error).message);
    },
  });

  // Fetch webhooks per project (only for the integrations tab)
  const { data: webhooksData } = useQuery({
    queryKey: ['all-webhooks', projects.map((p) => p.id)],
    queryFn: async () => {
      const results: Record<string, WebhookData[]> = {};
      for (const project of projects) {
        const res = await api.get<{ data: WebhookData[] }>(`/projects/${project.id}/webhooks`);
        results[project.id] = res.data;
      }
      return results;
    },
    enabled: activeTab === 'integrations' && projects.length > 0,
  });

  // Create webhook mutation
  const createWebhook = useMutation({
    mutationFn: ({ projectId, data }: { projectId: string; data: { url: string; events: string[]; secret: string } }) =>
      api.post(`/projects/${projectId}/webhooks`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-webhooks'] });
      setShowAddWebhook(null);
      setWebhookUrl('');
      setWebhookSecret('');
      setWebhookEvents([]);
    },
  });

  // Fetch helpdesk settings
  const { data: helpdeskSettingsRes } = useQuery({
    queryKey: ['helpdesk-settings'],
    queryFn: async () => {
      const res = await fetch('/helpdesk-api/helpdesk/settings', { credentials: 'include' });
      if (!res.ok) return null;
      const json = await res.json();
      return json.data ?? json;
    },
    enabled: activeTab === 'helpdesk',
  });

  // Fetch all projects for helpdesk default project picker
  const { data: helpdeskProjectsRes } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<PaginatedResponse<Project>>('/projects'),
    enabled: activeTab === 'helpdesk' || activeTab === 'integrations',
  });
  const helpdeskProjects = helpdeskProjectsRes?.data ?? [];

  // Fetch phases for selected helpdesk default project
  const { data: helpdeskPhasesRes } = useQuery({
    queryKey: ['project-phases', helpdeskDefaultProject],
    queryFn: () => api.get<{ data: { id: string; name: string }[] }>(`/projects/${helpdeskDefaultProject}/phases`),
    enabled: !!helpdeskDefaultProject && activeTab === 'helpdesk',
  });
  const helpdeskPhases = helpdeskPhasesRes?.data ?? [];

  // Load helpdesk settings into state when fetched
  useEffect(() => {
    if (helpdeskSettingsRes) {
      setHelpdeskRequireVerification(helpdeskSettingsRes.require_email_verification ?? false);
      setHelpdeskAllowedDomains((helpdeskSettingsRes.allowed_email_domains ?? []).join(', '));
      setHelpdeskDefaultProject(helpdeskSettingsRes.default_project_id ?? '');
      setHelpdeskDefaultPhase(helpdeskSettingsRes.default_phase_id ?? '');
      setHelpdeskWelcomeMessage(helpdeskSettingsRes.welcome_message ?? '');
      setHelpdeskCategories((helpdeskSettingsRes.ticket_categories ?? []).join('\n'));
      setHelpdeskNotifyOnStatus(helpdeskSettingsRes.notify_client_on_status_change ?? true);
      setHelpdeskNotifyOnReply(helpdeskSettingsRes.notify_client_on_agent_reply ?? true);
    }
  }, [helpdeskSettingsRes]);

  const handleSaveHelpdeskSettings = async () => {
    setHelpdeskSaving(true);
    try {
      const csrfMatch = typeof document !== 'undefined'
        ? document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)
        : null;
      const csrfHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfMatch) csrfHeaders['X-CSRF-Token'] = decodeURIComponent(csrfMatch[1]!);
      await fetch('/helpdesk-api/helpdesk/settings', {
        method: 'PATCH',
        credentials: 'include',
        headers: csrfHeaders,
        body: JSON.stringify({
          require_email_verification: helpdeskRequireVerification,
          allowed_email_domains: helpdeskAllowedDomains.split(',').map((d) => d.trim()).filter(Boolean),
          default_project_id: helpdeskDefaultProject || null,
          default_phase_id: helpdeskDefaultPhase || null,
          welcome_message: helpdeskWelcomeMessage,
          ticket_categories: helpdeskCategories.split('\n').map((c) => c.trim()).filter(Boolean),
          notify_client_on_status_change: helpdeskNotifyOnStatus,
          notify_client_on_agent_reply: helpdeskNotifyOnReply,
        }),
      });
      setHelpdeskSaved(true);
      setTimeout(() => setHelpdeskSaved(false), 2000);
      queryClient.invalidateQueries({ queryKey: ['helpdesk-settings'] });
    } catch {
      // error handling
    } finally {
      setHelpdeskSaving(false);
    }
  };

  // Delete webhook mutation
  const deleteWebhook = useMutation({
    mutationFn: (id: string) => api.delete(`/webhooks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-webhooks'] });
    },
  });

  // Update webhook mutation
  const updateWebhook = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { url: string; events: string[] } }) =>
      api.patch(`/webhooks/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-webhooks'] });
      setEditingWebhookId(null);
    },
  });

  // Slack integration: fetch current config for selected project
  const { data: slackIntegrationRes } = useQuery({
    queryKey: ['slack-integration', slackProjectId],
    queryFn: () => api.get<{ data: SlackIntegrationData | null }>(`/projects/${slackProjectId}/slack-integration`),
    enabled: activeTab === 'integrations' && !!slackProjectId,
  });

  // Load fetched slack config into form state when project changes
  useEffect(() => {
    if (!slackProjectId) return;
    const row = slackIntegrationRes?.data;
    if (row) {
      setSlackWebhookUrl(row.webhook_url);
      setSlackToken(row.slash_command_token ?? '');
      setSlackNotifyTaskCreated(row.notify_on_task_created);
      setSlackNotifyTaskCompleted(row.notify_on_task_completed);
      setSlackNotifySprintStarted(row.notify_on_sprint_started);
      setSlackNotifySprintCompleted(row.notify_on_sprint_completed);
      setSlackEnabled(row.enabled);
    } else {
      setSlackWebhookUrl('');
      setSlackToken('');
      setSlackNotifyTaskCreated(true);
      setSlackNotifyTaskCompleted(true);
      setSlackNotifySprintStarted(true);
      setSlackNotifySprintCompleted(true);
      setSlackEnabled(true);
    }
    setSlackTestStatus(null);
  }, [slackIntegrationRes, slackProjectId]);

  // Save Slack integration mutation (upsert)
  const saveSlack = useMutation({
    mutationFn: () =>
      api.put(`/projects/${slackProjectId}/slack-integration`, {
        webhook_url: slackWebhookUrl,
        slash_command_token: slackToken || null,
        notify_on_task_created: slackNotifyTaskCreated,
        notify_on_task_completed: slackNotifyTaskCompleted,
        notify_on_sprint_started: slackNotifySprintStarted,
        notify_on_sprint_completed: slackNotifySprintCompleted,
        enabled: slackEnabled,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['slack-integration', slackProjectId] });
    },
  });

  // Delete Slack integration mutation
  const deleteSlack = useMutation({
    mutationFn: () => api.delete(`/projects/${slackProjectId}/slack-integration`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['slack-integration', slackProjectId] });
    },
  });

  // Send test message mutation
  const testSlack = useMutation({
    mutationFn: () => api.post<{ data: { ok: boolean; status: number } }>(`/projects/${slackProjectId}/slack-integration/test`, {}),
    onSuccess: (res) => {
      setSlackTestStatus(res.data.ok ? `OK (${res.data.status})` : `Failed (${res.data.status})`);
    },
    onError: () => {
      setSlackTestStatus('Failed — see server logs');
    },
  });

  // GitHub integration: fetch current config + phases for selected project
  interface GithubIntegrationData {
    id: string;
    project_id: string;
    repo_owner: string;
    repo_name: string;
    transition_on_pr_open_phase_id: string | null;
    transition_on_pr_merged_phase_id: string | null;
    enabled: boolean;
    webhook_secret?: string | null;
  }
  const { data: ghIntegrationRes } = useQuery({
    queryKey: ['github-integration', ghProjectId],
    queryFn: () => api.get<{ data: GithubIntegrationData | null }>(`/projects/${ghProjectId}/github-integration`),
    enabled: activeTab === 'integrations' && !!ghProjectId,
  });
  const { data: ghPhasesRes } = useQuery({
    queryKey: ['project-phases', ghProjectId],
    queryFn: () => api.get<{ data: { id: string; name: string }[] }>(`/projects/${ghProjectId}/phases`),
    enabled: activeTab === 'integrations' && !!ghProjectId,
  });
  const ghPhases = ghPhasesRes?.data ?? [];

  useEffect(() => {
    if (!ghProjectId) return;
    const row = ghIntegrationRes?.data;
    if (row) {
      setGhRepoOwner(row.repo_owner);
      setGhRepoName(row.repo_name);
      setGhOpenPhaseId(row.transition_on_pr_open_phase_id ?? '');
      setGhMergedPhaseId(row.transition_on_pr_merged_phase_id ?? '');
      setGhEnabled(row.enabled);
    } else {
      setGhRepoOwner('');
      setGhRepoName('');
      setGhOpenPhaseId('');
      setGhMergedPhaseId('');
      setGhEnabled(true);
    }
    setGhRevealedSecret(null);
  }, [ghIntegrationRes, ghProjectId]);

  const saveGithub = useMutation({
    mutationFn: (opts: { regenerate?: boolean }) =>
      api.put<{ data: GithubIntegrationData & { webhook_secret: string | null } }>(
        `/projects/${ghProjectId}/github-integration`,
        {
          repo_owner: ghRepoOwner.trim(),
          repo_name: ghRepoName.trim(),
          transition_on_pr_open_phase_id: ghOpenPhaseId || null,
          transition_on_pr_merged_phase_id: ghMergedPhaseId || null,
          enabled: ghEnabled,
          regenerate_secret: opts.regenerate === true ? true : undefined,
        },
      ),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['github-integration', ghProjectId] });
      if (res.data.webhook_secret) setGhRevealedSecret(res.data.webhook_secret);
    },
  });

  const deleteGithub = useMutation({
    mutationFn: () => api.delete(`/projects/${ghProjectId}/github-integration`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['github-integration', ghProjectId] });
      setGhRevealedSecret(null);
    },
  });

  const handleCopyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    });
  };

  // Permissions tab state
  interface OrgPermissions {
    members_can_create_projects: boolean;
    members_can_delete_own_projects: boolean;
    members_can_create_channels: boolean;
    members_can_create_private_channels: boolean;
    members_can_create_group_dms: boolean;
    max_file_upload_mb: number;
    members_can_invite_members: boolean;
    members_can_create_api_keys: boolean;
    allowed_api_key_scopes: string[];
  }
  const DEFAULT_PERMS: OrgPermissions = {
    members_can_create_projects: true,
    members_can_delete_own_projects: false,
    members_can_create_channels: true,
    members_can_create_private_channels: true,
    members_can_create_group_dms: true,
    max_file_upload_mb: 25,
    members_can_invite_members: false,
    members_can_create_api_keys: true,
    allowed_api_key_scopes: ['read', 'read_write'],
  };
  const [permissions, setPermissions] = useState<OrgPermissions>(DEFAULT_PERMS);
  const [permissionsSaving, setPermissionsSaving] = useState(false);
  const [permissionsSaved, setPermissionsSaved] = useState(false);

  interface OrgData {
    id: string;
    name: string;
    slug: string;
    settings: { permissions?: Partial<OrgPermissions>; [key: string]: unknown } | null;
  }
  const { data: orgRes } = useQuery({
    queryKey: ['org'],
    queryFn: () => api.get<ApiResponse<OrgData>>('/org'),
    enabled: activeTab === 'permissions',
  });

  useEffect(() => {
    if (orgRes?.data) {
      const existing = orgRes.data.settings?.permissions ?? {};
      setPermissions({ ...DEFAULT_PERMS, ...existing });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgRes]);

  // Wave E.D: gate Org settings/permissions tab on the per-action permission
  // matrix (PATCH /org → bam.org.update) instead of inline role lookup.
  const canEditPermissions = useCan('bam.org.update');

  const updatePermissions = useMutation({
    mutationFn: (perms: OrgPermissions) => {
      const existingSettings = (orgRes?.data?.settings ?? {}) as Record<string, unknown>;
      return api.patch<ApiResponse<OrgData>>('/org', {
        settings: { ...existingSettings, permissions: perms },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org'] });
      setPermissionsSaved(true);
      setTimeout(() => setPermissionsSaved(false), 2000);
    },
    onSettled: () => setPermissionsSaving(false),
  });

  const handleSavePermissions = () => {
    setPermissionsSaving(true);
    updatePermissions.mutate(permissions);
  };

  const toggleApiKeyScope = (scope: string) => {
    setPermissions((p) => ({
      ...p,
      allowed_api_key_scopes: p.allowed_api_key_scopes.includes(scope)
        ? p.allowed_api_key_scopes.filter((s) => s !== scope)
        : [...p.allowed_api_key_scopes, scope],
    }));
  };

  const applyTheme = (newTheme: 'system' | 'light' | 'dark') => {
    setTheme(newTheme);
    localStorage.setItem('bbam-theme', newTheme);
    const root = document.documentElement;
    root.classList.remove('dark');
    if (newTheme === 'dark') {
      root.classList.add('dark');
    } else if (newTheme === 'system') {
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        root.classList.add('dark');
      }
    }
  };

  const handleSaveProfile = async () => {
    setSaving(true);
    try {
      await api.patch('/auth/me', { display_name: displayName, timezone });
      // Keep the in-store user in sync so the topbar/avatar reflect the change
      // without a full refetch.
      patchUser({ display_name: displayName, timezone });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // error handling
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async () => {
    setPwError(null);
    setPwSaved(false);
    if (newPassword.length < 12) {
      setPwError('New password must be at least 12 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwError('New password and confirmation do not match.');
      return;
    }
    if (currentPassword.length === 0) {
      setPwError('Current password is required.');
      return;
    }
    setPwSubmitting(true);
    try {
      await changePassword({ current_password: currentPassword, new_password: newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPwSaved(true);
      setTimeout(() => setPwSaved(false), 3000);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 && err.code === 'INVALID_CREDENTIALS') {
          setPwError('Current password is incorrect.');
        } else if (err.code === 'VALIDATION_ERROR') {
          setPwError('The new password does not meet the requirements.');
        } else {
          setPwError(err.message || 'Could not change password. Please try again.');
        }
      } else {
        setPwError('Could not change password. Please try again.');
      }
    } finally {
      setPwSubmitting(false);
    }
  };

  const handleSaveNotifications = async () => {
    setSavingNotif(true);
    try {
      // Merge onto the existing prefs object so unrelated keys (e.g. the FTUE
      // flag) survive — the API replaces the whole notification_prefs column.
      const merged = { ...(user?.notification_prefs ?? {}), ...notifPrefs };
      const res = await api.patch<{ data: { notification_prefs?: Record<string, unknown> } }>(
        '/auth/me',
        { notification_prefs: merged },
      );
      patchUser({ notification_prefs: res.data.notification_prefs ?? merged });
      setSavedNotif(true);
      setTimeout(() => setSavedNotif(false), 2000);
    } catch {
      // error handling
    } finally {
      setSavingNotif(false);
    }
  };

  const tabs = [
    { id: 'profile' as const, label: 'Profile', icon: User },
    { id: 'password' as const, label: 'Password', icon: KeyRound },
    { id: 'appearance' as const, label: 'Appearance', icon: Sun },
    { id: 'notifications' as const, label: 'Notifications', icon: Bell },
    { id: 'members' as const, label: 'Members', icon: Users },
    { id: 'tasks' as const, label: 'Tasks', icon: ListChecks },
    { id: 'permissions' as const, label: 'Permissions', icon: Lock },
    { id: 'launchpad' as const, label: 'Launchpad', icon: LayoutGrid },
    { id: 'integrations' as const, label: 'Integrations', icon: Plug },
    { id: 'ai-providers' as const, label: 'AI Providers', icon: Zap },
    { id: 'helpdesk' as const, label: 'Helpdesk', icon: Headset },
  ];

  return (
    <AppLayout
      breadcrumbs={[{ label: 'Settings' }]}
      onNavigate={onNavigate}
      onCreateProject={() => onNavigate('/')}
    >
      <div className="max-w-4xl mx-auto p-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-6">Settings</h1>

        <div className="flex gap-6">
          <nav className="w-48 shrink-0">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-primary-50 text-primary-700 dark:bg-zinc-800 dark:text-primary-400'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
                }`}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="flex-1">
            {activeTab === 'profile' && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Profile</h2>
                  <p className="text-sm text-zinc-500">Update your personal information.</p>
                </div>
                <div data-ftue="display-name">
                  <Input
                    id="display-name"
                    label="Display Name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
                <Input
                  id="email"
                  label="Email"
                  value={user?.email ?? ''}
                  disabled
                />
                <div className="flex flex-col gap-1.5" data-ftue="timezone">
                  <Select
                    label="Timezone"
                    options={timezoneSelectOptions(timezone)}
                    value={timezone || 'UTC'}
                    onValueChange={setTimezone}
                    className="w-full"
                  />
                </div>
                <div className="flex items-center gap-3" data-ftue="profile-save">
                  <Button onClick={handleSaveProfile} loading={saving}>Save Changes</Button>
                  {saved && <span className="text-sm text-green-600">Saved!</span>}
                </div>
              </div>
            )}

            {activeTab === 'password' && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Password</h2>
                  <p className="text-sm text-zinc-500">Change the password you use to sign in.</p>
                </div>
                <form
                  className="space-y-6"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!pwSubmitting) void handleChangePassword();
                  }}
                >
                  <Input
                    id="current-password"
                    label="Current password"
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    disabled={pwSubmitting}
                  />
                  <div className="space-y-1.5">
                    <Input
                      id="new-password"
                      label="New password"
                      type="password"
                      autoComplete="new-password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      disabled={pwSubmitting}
                    />
                    <p className="text-xs text-zinc-500">Must be at least 12 characters.</p>
                  </div>
                  <Input
                    id="confirm-password"
                    label="Confirm new password"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={pwSubmitting}
                  />
                  {pwError && (
                    <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-800 dark:text-red-300">
                      {pwError}
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <Button type="submit" loading={pwSubmitting}>Update Password</Button>
                    {pwSaved && <span className="text-sm text-green-600">Password updated!</span>}
                  </div>
                </form>
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Appearance</h2>
                  <p className="text-sm text-zinc-500">Customize how BigBlueBam looks.</p>
                </div>
                <div data-ftue="theme">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 block">Theme</label>
                  <div className="flex gap-3">
                    {([
                      { value: 'system' as const, label: 'System', icon: Monitor },
                      { value: 'light' as const, label: 'Light', icon: Sun },
                      { value: 'dark' as const, label: 'Dark', icon: Moon },
                    ]).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => applyTheme(opt.value)}
                        className={`flex items-center gap-2 rounded-lg border-2 px-4 py-3 text-sm font-medium transition-colors ${
                          theme === opt.value
                            ? 'border-primary-500 bg-primary-50 text-primary-700 dark:bg-zinc-800 dark:text-primary-400'
                            : 'border-zinc-200 text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-400'
                        }`}
                      >
                        <opt.icon className="h-4 w-4" />
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Notifications</h2>
                  <p className="text-sm text-zinc-500">Configure how you receive notifications.</p>
                </div>
                <div className="space-y-4" data-ftue="notifications">
                  {NOTIFICATION_PREFS.map((pref) => (
                    <label key={pref.key} className="flex items-center justify-between cursor-pointer">
                      <span className="text-sm text-zinc-700 dark:text-zinc-300">{pref.label}</span>
                      <input
                        type="checkbox"
                        checked={notifPrefs[pref.key] ?? true}
                        onChange={(e) =>
                          setNotifPrefs((prev) => ({ ...prev, [pref.key]: e.target.checked }))
                        }
                        className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                      />
                    </label>
                  ))}
                </div>
                <div
                  className="flex items-center gap-3 pt-2 border-t border-zinc-100 dark:border-zinc-800"
                  data-ftue="notif-save"
                >
                  <Button onClick={handleSaveNotifications} loading={savingNotif}>
                    Save Preferences
                  </Button>
                  {savedNotif && <span className="text-sm text-green-600">Saved!</span>}
                </div>
              </div>
            )}

            {activeTab === 'tasks' && (
              <TasksTab onOpenPriorityManager={() => setPriorityManagerOpen(true)} />
            )}
            {activeTab === 'members' && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-8 text-center space-y-3">
                <Users className="h-10 w-10 text-zinc-400 mx-auto" />
                <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Member management has moved</h2>
                <p className="text-sm text-zinc-500 max-w-md mx-auto">
                  Invite, edit, and manage members on the dedicated People page.
                </p>
                <Button onClick={() => onNavigate('/people')}>Go to People</Button>
              </div>
            )}
            {activeTab === 'integrations' && (
              <div className="space-y-6">
                {/* Calendar Feeds */}
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Calendar Feeds</h2>
                    <p className="text-sm text-zinc-500">
                      Subscribe to these URLs in Google Calendar, Outlook, or Apple Calendar to see task due dates.
                    </p>
                  </div>

                  <div className="space-y-3">
                    {/* Personal calendar */}
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 dark:border-zinc-700 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">My Tasks (Personal)</p>
                        <p className="text-xs text-zinc-400 truncate font-mono">
                          {window.location.origin}/b3/api/me/calendar.ics?token=API_KEY
                        </p>
                      </div>
                      <button
                        onClick={() => handleCopyUrl(`${window.location.origin}/b3/api/me/calendar.ics?token=API_KEY`)}
                        className="shrink-0 rounded-md p-2 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        title="Copy URL"
                      >
                        {copiedUrl === `${window.location.origin}/b3/api/me/calendar.ics?token=API_KEY` ? (
                          <Check className="h-4 w-4 text-green-500" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    <p className="text-xs text-zinc-400 -mt-1 ml-1">
                      Replace API_KEY with an actual API key from the section below.
                    </p>

                    {/* Per-project calendars */}
                    {projects.map((project) => {
                      const url = `${window.location.origin}/b3/api/projects/${project.id}/calendar.ics`;
                      return (
                        <div key={project.id} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 dark:border-zinc-700 px-4 py-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{project.name}</p>
                            <p className="text-xs text-zinc-400 truncate font-mono">{url}</p>
                          </div>
                          <button
                            onClick={() => handleCopyUrl(url)}
                            className="shrink-0 rounded-md p-2 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                            title="Copy URL"
                          >
                            {copiedUrl === url ? (
                              <Check className="h-4 w-4 text-green-500" />
                            ) : (
                              <Copy className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      );
                    })}
                    {projects.length === 0 && (
                      <p className="text-sm text-zinc-400">No projects found.</p>
                    )}
                  </div>
                </div>

                {/* API Keys */}
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">API Keys</h2>
                      <p className="text-sm text-zinc-500">
                        Use API keys to authenticate with the MCP server or REST API.
                      </p>
                    </div>
                    <Button size="sm" onClick={() => setShowCreateKey((v) => !v)}>
                      <Plus className="h-4 w-4" />
                      Create API Key
                    </Button>
                  </div>

                  {createdKeyValue && (
                    <div className="p-4 rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 space-y-2">
                      <p className="text-sm font-medium text-green-800 dark:text-green-200">
                        API key created! Copy it now -- it will not be shown again.
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs bg-white dark:bg-zinc-900 rounded px-3 py-2 font-mono border border-green-200 dark:border-green-800 break-all">
                          {createdKeyValue}
                        </code>
                        <button
                          onClick={() => handleCopyUrl(createdKeyValue)}
                          className="shrink-0 rounded-md p-2 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                          {copiedUrl === createdKeyValue ? (
                            <Check className="h-4 w-4 text-green-500" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                      <button
                        onClick={() => setCreatedKeyValue(null)}
                        className="text-xs text-green-700 dark:text-green-300 underline"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}

                  {showCreateKey && (
                    <div className="p-4 rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50 space-y-3">
                      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Create a new API key</h3>
                      <div className="flex gap-3 items-end flex-wrap">
                        <Input
                          id="key-name"
                          label="Name"
                          placeholder="e.g. MCP Server"
                          value={newKeyName}
                          onChange={(e) => setNewKeyName(e.target.value)}
                          className="w-56"
                        />
                        <div
                          title={
                            user?.role === 'owner' || user?.is_superuser === true
                              ? undefined
                              : 'Admin-scope keys can only be created by an organization owner.'
                          }
                        >
                          <Select
                            label="Scope"
                            options={[
                              { value: 'read', label: 'Read' },
                              { value: 'read_write', label: 'Read / Write' },
                              ...(user?.role === 'owner' || user?.is_superuser === true
                                ? [{ value: 'admin', label: 'Admin' }]
                                : []),
                            ]}
                            value={newKeyScope}
                            onValueChange={setNewKeyScope}
                            className="w-32"
                          />
                        </div>
                        <Button
                          size="sm"
                          onClick={() => createApiKey.mutate({ name: newKeyName, scope: newKeyScope })}
                          loading={createApiKey.isPending}
                          disabled={!newKeyName.trim()}
                        >
                          Create
                        </Button>
                      </div>
                      {user?.role !== 'owner' && user?.is_superuser !== true && (
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          Admin-scope keys can only be created by an organization owner.
                        </p>
                      )}
                    </div>
                  )}

                  {apiKeysData.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left">
                            <th className="pb-2 font-medium text-zinc-500">Name</th>
                            <th className="pb-2 font-medium text-zinc-500">Key</th>
                            <th className="pb-2 font-medium text-zinc-500">Scope</th>
                            <th className="pb-2 font-medium text-zinc-500">Created</th>
                            <th className="pb-2 font-medium text-zinc-500 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {apiKeysData.map((key) => (
                            <tr key={key.id} className="border-b border-zinc-100 dark:border-zinc-800">
                              <td className="py-3 text-zinc-900 dark:text-zinc-100">{key.name}</td>
                              <td className="py-3 text-zinc-500 font-mono text-xs">{key.key_hint}</td>
                              <td className="py-3 text-zinc-600 dark:text-zinc-400 capitalize">{key.scope}</td>
                              <td className="py-3 text-zinc-500">{formatDate(key.created_at)}</td>
                              <td className="py-3 text-right">
                                <Button
                                  size="sm"
                                  variant="danger"
                                  onClick={() => revokeApiKey.mutate(key.id)}
                                  loading={revokeApiKey.isPending}
                                >
                                  Revoke
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-400">No API keys created yet.</p>
                  )}
                </div>

                {/* Agents (service accounts) */}
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
                        <Bot className="h-5 w-5 text-primary-600" />
                        Agents
                      </h2>
                      <p className="text-sm text-zinc-500">
                        Service accounts for automations and AI agents. The account
                        is owned by you and cannot act beyond your own permissions.
                      </p>
                    </div>
                    <Button size="sm" onClick={() => setShowCreateAgent((v) => !v)}>
                      <Plus className="h-4 w-4" />
                      New Agent
                    </Button>
                  </div>

                  {createdAgentKey && (
                    <div className="p-4 rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 space-y-2">
                      <p className="text-sm font-medium text-green-800 dark:text-green-200">
                        Agent "{createdAgentKey.name}" created. Copy its API key now — it will not be shown again.
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs bg-white dark:bg-zinc-900 rounded px-3 py-2 font-mono border border-green-200 dark:border-green-800 break-all">
                          {createdAgentKey.key}
                        </code>
                        <button
                          onClick={() => handleCopyUrl(createdAgentKey.key)}
                          className="shrink-0 rounded-md p-2 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                          {copiedUrl === createdAgentKey.key ? (
                            <Check className="h-4 w-4 text-green-500" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                      <button
                        onClick={() => setCreatedAgentKey(null)}
                        className="text-xs text-green-700 dark:text-green-300 underline"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}

                  {agentMutationError && (
                    <div className="p-4 rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950 space-y-1">
                      <p className="text-sm font-medium text-red-800 dark:text-red-200">
                        Action failed: {agentMutationError}
                      </p>
                      <button
                        onClick={() => setAgentMutationError(null)}
                        className="text-xs text-red-700 dark:text-red-300 underline"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}

                  {rotatedAgentKey && (
                    <div className="p-4 rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950 space-y-2">
                      <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                        Rotated key for "{rotatedAgentKey.name}". Copy it now — a new token will not be shown again. The old key works for 7 more days while you migrate.
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs bg-white dark:bg-zinc-900 rounded px-3 py-2 font-mono border border-blue-200 dark:border-blue-800 break-all">
                          {rotatedAgentKey.key}
                        </code>
                        <button
                          onClick={() => handleCopyUrl(rotatedAgentKey.key)}
                          className="shrink-0 rounded-md p-2 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                          {copiedUrl === rotatedAgentKey.key ? (
                            <Check className="h-4 w-4 text-green-500" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                      <button
                        onClick={() => setRotatedAgentKey(null)}
                        className="text-xs text-blue-700 dark:text-blue-300 underline"
                      >
                        Dismiss
                      </button>
                    </div>
                  )}

                  {showCreateAgent && (
                    <div className="p-4 rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50 space-y-3">
                      <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Create a new agent</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <Input
                          id="agent-name"
                          label="Name"
                          placeholder="e.g. Daily Stand-up Bot"
                          value={newAgentName}
                          onChange={(e) => setNewAgentName(e.target.value)}
                        />
                        <div
                          title={
                            user?.role === 'owner' || user?.is_superuser === true
                              ? undefined
                              : 'Admin-scope agents can only be created by an organization owner.'
                          }
                        >
                          <Select
                            label="Scope"
                            options={[
                              { value: 'read', label: 'Read' },
                              { value: 'read_write', label: 'Read / Write' },
                              ...(user?.role === 'owner' || user?.is_superuser === true
                                ? [{ value: 'admin', label: 'Admin' }]
                                : []),
                            ]}
                            value={newAgentScope}
                            onValueChange={setNewAgentScope}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
                          Restrict to projects <span className="text-zinc-400">(optional — leave empty for org-wide)</span>
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {projects.length === 0 ? (
                            <p className="text-xs text-zinc-400">No projects available.</p>
                          ) : (
                            projects.map((p) => {
                              const on = newAgentProjectIds.includes(p.id);
                              return (
                                <button
                                  type="button"
                                  key={p.id}
                                  onClick={() =>
                                    setNewAgentProjectIds((prev) =>
                                      on ? prev.filter((id) => id !== p.id) : [...prev, p.id],
                                    )
                                  }
                                  className={
                                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ' +
                                    (on
                                      ? 'border-primary-500 bg-primary-100 text-primary-800 dark:bg-primary-900/40 dark:text-primary-200'
                                      : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800')
                                  }
                                >
                                  {on && <Check className="h-3 w-3" />}
                                  {p.name}
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">
                          Allowed tool patterns <span className="text-zinc-400">(one per line — leave empty for full allowlist)</span>
                        </label>
                        <textarea
                          value={newAgentAllowedTools}
                          onChange={(e) => setNewAgentAllowedTools(e.target.value)}
                          placeholder="banter_*&#10;bond_get_*&#10;get_me"
                          rows={3}
                          className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                        <p className="mt-1 text-xs text-zinc-500">
                          Patterns use glob-prefix syntax (<code className="text-xs">banter_*</code> matches every Banter tool). Runtime role/scope checks still apply — this is an extra filter, not an escalation.
                        </p>
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          size="sm"
                          onClick={() => {
                            const tools = newAgentAllowedTools
                              .split('\n')
                              .map((s) => s.trim())
                              .filter(Boolean);
                            createAgent.mutate({
                              name: newAgentName,
                              scope: newAgentScope,
                              project_ids: newAgentProjectIds.length > 0 ? newAgentProjectIds : undefined,
                              allowed_tools: tools.length > 0 ? tools : undefined,
                            });
                          }}
                          loading={createAgent.isPending}
                          disabled={!newAgentName.trim()}
                        >
                          Create Agent
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setShowCreateAgent(false)}>
                          Cancel
                        </Button>
                      </div>
                      {createAgent.isError && (
                        <p className="text-xs text-red-600 dark:text-red-400">
                          Failed: {(createAgent.error as Error).message}
                        </p>
                      )}
                    </div>
                  )}

                  {agentsData.length > 0 ? (
                    <div className="overflow-x-auto">
                      {(() => {
                        const isRevoked = (a: (typeof agentsData)[number]) =>
                          a.disabled_at !== null || a.policy?.enabled === false;
                        const revokedCount = agentsData.filter(isRevoked).length;
                        return revokedCount > 0 ? (
                          <div className="flex justify-end mb-2">
                            <button
                              type="button"
                              onClick={() => setShowRevokedAgents((v) => !v)}
                              className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline"
                            >
                              {showRevokedAgents
                                ? `Hide revoked (${revokedCount})`
                                : `Show revoked (${revokedCount})`}
                            </button>
                          </div>
                        ) : null;
                      })()}
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-zinc-200 dark:border-zinc-700 text-left">
                            <th className="pb-2 font-medium text-zinc-500">Name</th>
                            <th className="pb-2 font-medium text-zinc-500">Key</th>
                            <th className="pb-2 font-medium text-zinc-500">Scope</th>
                            <th className="pb-2 font-medium text-zinc-500">Projects</th>
                            <th className="pb-2 font-medium text-zinc-500">Status</th>
                            <th className="pb-2 font-medium text-zinc-500 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {agentsData
                            .filter(
                              (agent) =>
                                showRevokedAgents ||
                                !(agent.disabled_at !== null || agent.policy?.enabled === false),
                            )
                            .map((agent) => {
                            const isDisabled = agent.disabled_at !== null || agent.policy?.enabled === false;
                            const projectNames = (agent.api_key?.project_ids ?? []).map(
                              (id) => projects.find((p) => p.id === id)?.name ?? id.slice(0, 8),
                            );
                            return (
                              <tr key={agent.id} className="border-b border-zinc-100 dark:border-zinc-800">
                                <td className="py-3">
                                  <div className="font-medium text-zinc-900 dark:text-zinc-100">{agent.name}</div>
                                  {agent.created_by && (
                                    <div className="text-xs text-zinc-500">
                                      by {agent.created_by.display_name || agent.created_by.id.slice(0, 8)}
                                    </div>
                                  )}
                                </td>
                                <td className="py-3 text-zinc-500 font-mono text-xs">
                                  {agent.api_key?.key_hint ?? '—'}
                                </td>
                                <td className="py-3 text-zinc-600 dark:text-zinc-400 capitalize">
                                  {agent.api_key?.scope ?? '—'}
                                </td>
                                <td className="py-3 text-zinc-500 text-xs">
                                  {projectNames.length === 0 ? (
                                    <span className="text-zinc-400">org-wide</span>
                                  ) : (
                                    <span className="truncate max-w-xs inline-block" title={projectNames.join(', ')}>
                                      {projectNames.join(', ')}
                                    </span>
                                  )}
                                </td>
                                <td className="py-3">
                                  {isDisabled ? (
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400">
                                      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                                      Revoked
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                                      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                                      Active
                                    </span>
                                  )}
                                </td>
                                <td className="py-3 text-right">
                                  <div className="inline-flex items-center gap-1.5">
                                    {!isDisabled && agent.api_key && (
                                      <Button
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => {
                                          if (window.confirm(`Rotate key for "${agent.name}"? A new token will be displayed once. The old key continues to work for 7 days while you migrate.`)) {
                                            setAgentMutationError(null);
                                            rotateAgentKey.mutate(agent.id);
                                          }
                                        }}
                                        loading={rotateAgentKey.isPending && rotateAgentKey.variables === agent.id}
                                      >
                                        <RefreshCw className="h-3.5 w-3.5" />
                                        Rotate
                                      </Button>
                                    )}
                                    {!isDisabled && (
                                      <Button
                                        size="sm"
                                        variant="danger"
                                        onClick={() => {
                                          if (window.confirm(`Revoke agent "${agent.name}"? Its key is deleted and the policy is disabled.`)) {
                                            setAgentMutationError(null);
                                            revokeAgent.mutate(agent.id);
                                          }
                                        }}
                                        loading={revokeAgent.isPending && revokeAgent.variables === agent.id}
                                      >
                                        Revoke
                                      </Button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-400">No agents created yet.</p>
                  )}
                </div>

                {/* Webhooks */}
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Webhooks</h2>
                    <p className="text-sm text-zinc-500">
                      Receive HTTP POST notifications when events occur. Configure webhooks per project.
                    </p>
                  </div>

                  {projects.map((project) => {
                    const projectWebhooks = webhooksData?.[project.id] ?? [];
                    return (
                      <div key={project.id} className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{project.name}</h3>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setShowAddWebhook(showAddWebhook === project.id ? null : project.id)}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add Webhook
                          </Button>
                        </div>

                        {showAddWebhook === project.id && (
                          <div className="p-4 rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50 space-y-3">
                            <Input
                              id={`webhook-url-${project.id}`}
                              label="URL"
                              placeholder="https://example.com/webhook"
                              value={webhookUrl}
                              onChange={(e) => setWebhookUrl(e.target.value)}
                            />
                            <Input
                              id={`webhook-secret-${project.id}`}
                              label="Secret (min 16 characters)"
                              placeholder="your-webhook-secret"
                              value={webhookSecret}
                              onChange={(e) => setWebhookSecret(e.target.value)}
                            />
                            <div>
                              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2 block">Events</label>
                              <div className="flex flex-wrap gap-2">
                                {WEBHOOK_EVENT_TYPES.map((evt) => (
                                  <label key={evt} className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
                                    <input
                                      type="checkbox"
                                      checked={webhookEvents.includes(evt)}
                                      onChange={(e) => {
                                        if (e.target.checked) {
                                          setWebhookEvents((prev) => [...prev, evt]);
                                        } else {
                                          setWebhookEvents((prev) => prev.filter((x) => x !== evt));
                                        }
                                      }}
                                      className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                                    />
                                    {evt}
                                  </label>
                                ))}
                              </div>
                            </div>
                            <Button
                              size="sm"
                              onClick={() =>
                                createWebhook.mutate({
                                  projectId: project.id,
                                  data: { url: webhookUrl, events: webhookEvents, secret: webhookSecret },
                                })
                              }
                              loading={createWebhook.isPending}
                              disabled={!webhookUrl.trim() || webhookSecret.length < 16 || webhookEvents.length === 0}
                            >
                              Save Webhook
                            </Button>
                          </div>
                        )}

                        {projectWebhooks.length > 0 ? (
                          <div className="space-y-2">
                            {projectWebhooks.map((wh) => (
                              <div key={wh.id}>
                                <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 dark:border-zinc-700 px-4 py-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-mono text-zinc-700 dark:text-zinc-300 truncate">{wh.url}</p>
                                    <p className="text-xs text-zinc-400">
                                      {wh.events.join(', ')} &middot; {wh.is_active ? 'Active' : 'Inactive'}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <button
                                      onClick={() => {
                                        setEditingWebhookId(editingWebhookId === wh.id ? null : wh.id);
                                        setEditWebhookUrl(wh.url);
                                        setEditWebhookEvents([...wh.events]);
                                      }}
                                      className="p-1.5 rounded-md text-zinc-400 hover:text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-950 transition-colors"
                                      title="Edit webhook"
                                    >
                                      <Pencil className="h-4 w-4" />
                                    </button>
                                    <button
                                      onClick={() => deleteWebhook.mutate(wh.id)}
                                      className="p-1.5 rounded-md text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                                      title="Delete webhook"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </button>
                                  </div>
                                </div>
                                {editingWebhookId === wh.id && (
                                  <div className="mt-2 p-4 rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/50 space-y-3">
                                    <Input
                                      id={`edit-webhook-url-${wh.id}`}
                                      label="URL"
                                      value={editWebhookUrl}
                                      onChange={(e) => setEditWebhookUrl(e.target.value)}
                                    />
                                    <div>
                                      <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2 block">Events</label>
                                      <div className="flex flex-wrap gap-2">
                                        {WEBHOOK_EVENT_TYPES.map((evt) => (
                                          <label key={evt} className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
                                            <input
                                              type="checkbox"
                                              checked={editWebhookEvents.includes(evt)}
                                              onChange={(e) => {
                                                if (e.target.checked) {
                                                  setEditWebhookEvents((prev) => [...prev, evt]);
                                                } else {
                                                  setEditWebhookEvents((prev) => prev.filter((x) => x !== evt));
                                                }
                                              }}
                                              className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                                            />
                                            {evt}
                                          </label>
                                        ))}
                                      </div>
                                    </div>
                                    <div className="flex gap-2">
                                      <Button
                                        size="sm"
                                        onClick={() =>
                                          updateWebhook.mutate({
                                            id: wh.id,
                                            data: { url: editWebhookUrl, events: editWebhookEvents },
                                          })
                                        }
                                        loading={updateWebhook.isPending}
                                        disabled={!editWebhookUrl.trim() || editWebhookEvents.length === 0}
                                      >
                                        Save Changes
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => setEditingWebhookId(null)}
                                      >
                                        Cancel
                                      </Button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-zinc-400 ml-1">No webhooks configured.</p>
                        )}
                      </div>
                    );
                  })}
                  {projects.length === 0 && (
                    <p className="text-sm text-zinc-400">No projects found.</p>
                  )}
                </div>

                {/* Slack Integration */}
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Slack</h2>
                    <p className="text-sm text-zinc-500">
                      Send task and sprint events to a Slack channel via an incoming webhook URL.
                    </p>
                  </div>

                  <div>
                    <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1 block">Project</label>
                    <select
                      value={slackProjectId}
                      onChange={(e) => setSlackProjectId(e.target.value)}
                      className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:bg-zinc-900 dark:border-zinc-700"
                    >
                      <option value="">Select a project…</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>

                  {slackProjectId && (
                    <>
                      <Input
                        id="slack-webhook-url"
                        label="Incoming webhook URL"
                        type="password"
                        placeholder="https://hooks.slack.com/services/T00/B00/XXX"
                        value={slackWebhookUrl}
                        onChange={(e) => setSlackWebhookUrl(e.target.value)}
                      />
                      <Input
                        id="slack-token"
                        label="Slash command verification token (optional)"
                        type="password"
                        placeholder="Leave blank if not using /bbb"
                        value={slackToken}
                        onChange={(e) => setSlackToken(e.target.value)}
                      />

                      <div className="space-y-2">
                        <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Notify on</label>
                        {[
                          ['task.created', slackNotifyTaskCreated, setSlackNotifyTaskCreated] as const,
                          ['task.completed', slackNotifyTaskCompleted, setSlackNotifyTaskCompleted] as const,
                          ['sprint.started', slackNotifySprintStarted, setSlackNotifySprintStarted] as const,
                          ['sprint.completed', slackNotifySprintCompleted, setSlackNotifySprintCompleted] as const,
                        ].map(([label, val, setter]) => (
                          <label key={label} className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                            <input
                              type="checkbox"
                              checked={val}
                              onChange={(e) => setter(e.target.checked)}
                              className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                            />
                            {label}
                          </label>
                        ))}
                        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400 pt-2 border-t border-zinc-200 dark:border-zinc-800">
                          <input
                            type="checkbox"
                            checked={slackEnabled}
                            onChange={(e) => setSlackEnabled(e.target.checked)}
                            className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                          />
                          Integration enabled
                        </label>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap">
                        <Button
                          size="sm"
                          onClick={() => saveSlack.mutate()}
                          loading={saveSlack.isPending}
                          disabled={!slackWebhookUrl.trim()}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => testSlack.mutate()}
                          loading={testSlack.isPending}
                          disabled={!slackIntegrationRes?.data}
                        >
                          Send test message
                        </Button>
                        {slackIntegrationRes?.data && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => deleteSlack.mutate()}
                            loading={deleteSlack.isPending}
                          >
                            Disconnect
                          </Button>
                        )}
                        {slackTestStatus && (
                          <span className="text-xs text-zinc-500">Test: {slackTestStatus}</span>
                        )}
                      </div>
                    </>
                  )}

                  <div className="text-xs text-zinc-500 space-y-1 pt-2 border-t border-zinc-200 dark:border-zinc-800">
                    <p>
                      <strong>Incoming webhook:</strong> In your Slack workspace → Apps → Incoming Webhooks →
                      Add to channel → copy URL here.
                    </p>
                    <p>
                      <strong>Slash command:</strong> Apps → Create App → Slash Commands → add <code className="font-mono">/bbb</code>
                      {' '}with request URL <code className="font-mono">/b3/api/webhooks/slack/command</code>.
                    </p>
                  </div>
                </div>

                {/* GitHub Integration */}
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">GitHub</h2>
                    <p className="text-sm text-zinc-500">
                      Auto-link commits and pull requests that mention a task (e.g. <code className="font-mono text-xs">MAGE-38</code>), and optionally transition tasks when PRs open or merge.
                    </p>
                  </div>

                  <Select
                    label="Project"
                    options={[
                      { value: '', label: 'Select a project…' },
                      ...projects.map((p) => ({ value: p.id, label: p.name })),
                    ]}
                    value={ghProjectId}
                    onValueChange={setGhProjectId}
                  />

                  {ghProjectId && (
                    <div className="space-y-4 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Input
                          id="gh-repo-owner"
                          label="Repo Owner"
                          placeholder="octocat"
                          value={ghRepoOwner}
                          onChange={(e) => setGhRepoOwner(e.target.value)}
                        />
                        <Input
                          id="gh-repo-name"
                          label="Repo Name"
                          placeholder="hello-world"
                          value={ghRepoName}
                          onChange={(e) => setGhRepoName(e.target.value)}
                        />
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Select
                          label="Move to phase when PR opens"
                          options={[
                            { value: '', label: '— none —' },
                            ...ghPhases.map((p) => ({ value: p.id, label: p.name })),
                          ]}
                          value={ghOpenPhaseId}
                          onValueChange={setGhOpenPhaseId}
                        />
                        <Select
                          label="Move to phase when PR merges"
                          options={[
                            { value: '', label: '— none —' },
                            ...ghPhases.map((p) => ({ value: p.id, label: p.name })),
                          ]}
                          value={ghMergedPhaseId}
                          onValueChange={setGhMergedPhaseId}
                        />
                      </div>

                      <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                        <input
                          type="checkbox"
                          checked={ghEnabled}
                          onChange={(e) => setGhEnabled(e.target.checked)}
                          className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                        />
                        Enabled
                      </label>

                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => saveGithub.mutate({})}
                          loading={saveGithub.isPending}
                          disabled={!ghRepoOwner.trim() || !ghRepoName.trim()}
                        >
                          {ghIntegrationRes?.data ? 'Save Changes' : 'Connect GitHub'}
                        </Button>
                        {ghIntegrationRes?.data && (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => saveGithub.mutate({ regenerate: true })}
                              loading={saveGithub.isPending}
                            >
                              Regenerate Secret
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => deleteGithub.mutate()}
                              loading={deleteGithub.isPending}
                            >
                              Disconnect
                            </Button>
                          </>
                        )}
                      </div>

                      {ghRevealedSecret && (
                        <div className="p-4 rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 space-y-3">
                          <p className="text-sm font-medium text-green-800 dark:text-green-200">
                            Webhook secret generated. Copy it now — it will not be shown again.
                          </p>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 text-xs bg-white dark:bg-zinc-900 rounded px-3 py-2 font-mono border border-green-200 dark:border-green-800 break-all">
                              {ghRevealedSecret}
                            </code>
                            <button
                              onClick={() => handleCopyUrl(ghRevealedSecret)}
                              className="shrink-0 rounded-md p-2 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                            >
                              {copiedUrl === ghRevealedSecret ? (
                                <Check className="h-4 w-4 text-green-500" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </button>
                          </div>
                          <div className="text-xs text-green-900 dark:text-green-100 space-y-1.5">
                            <p className="font-semibold">Setup instructions</p>
                            <p>In your GitHub repo → <strong>Settings</strong> → <strong>Webhooks</strong> → <strong>Add webhook</strong>:</p>
                            <ul className="list-disc list-inside space-y-0.5 ml-1">
                              <li>
                                <strong>Payload URL:</strong>{' '}
                                <code className="font-mono bg-white/60 dark:bg-zinc-900/60 px-1 rounded">
                                  {window.location.origin}/b3/api/webhooks/github
                                </code>
                              </li>
                              <li><strong>Content type:</strong> <code className="font-mono">application/json</code></li>
                              <li><strong>Secret:</strong> (the value above)</li>
                              <li><strong>Events:</strong> check "Pushes" and "Pull requests"</li>
                              <li><strong>Active:</strong> checked</li>
                            </ul>
                          </div>
                          <button
                            onClick={() => setGhRevealedSecret(null)}
                            className="text-xs text-green-700 dark:text-green-300 underline"
                          >
                            Dismiss
                          </button>
                        </div>
                      )}

                      {ghIntegrationRes?.data && !ghRevealedSecret && (
                        <div className="text-xs text-zinc-500 space-y-1">
                          <p>
                            <strong>Payload URL:</strong>{' '}
                            <code className="font-mono">{window.location.origin}/b3/api/webhooks/github</code>
                          </p>
                          <p>Secret is set. Use "Regenerate Secret" if you need to rotate it.</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Slack Import — multi-step workspace import wizard.
                    The card returns null for users without
                    banter.admin_import.create, so it cleanly disappears for
                    non-admins. */}
                <SlackImportCard onNavigate={onNavigate} />

                {/* Per-org SMTP override. The platform-wide relay now lives in
                    the SuperUser Console → Platform tab; this org-level form
                    overrides it for this org's outbound mail. */}
                <OrgSmtpSettingsForm canEdit={canEditPermissions} />
                {user?.is_superuser === true && (
                  <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-4 flex items-start gap-2">
                    <Info className="h-4 w-4 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      The platform-wide SMTP relay (used for new-org invitations,
                      password-reset fallback, and system alerts) now lives in the{' '}
                      <button
                        type="button"
                        onClick={() => onNavigate('/superuser')}
                        className="font-medium underline hover:no-underline"
                      >
                        SuperUser Console &rarr; Platform
                      </button>{' '}
                      tab.
                    </p>
                  </div>
                )}
              </div>
            )}
            {activeTab === 'permissions' && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Organization Permissions</h2>
                  <p className="text-sm text-zinc-500">
                    Control what regular members can do within your organization. Admins and owners are not affected by these settings.
                  </p>
                  {!canEditPermissions && (
                    <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                      You need the admin or owner role to modify these settings.
                    </p>
                  )}
                </div>

                <fieldset disabled={!canEditPermissions} className="space-y-6 disabled:opacity-60">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Projects</h3>
                    <div className="space-y-3">
                      <label className="flex items-center justify-between">
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">Members can create projects</span>
                        <input
                          type="checkbox"
                          checked={permissions.members_can_create_projects}
                          onChange={(e) => setPermissions((p) => ({ ...p, members_can_create_projects: e.target.checked }))}
                          className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                        />
                      </label>
                      <label className="flex items-center justify-between">
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">Members can delete projects they own</span>
                        <input
                          type="checkbox"
                          checked={permissions.members_can_delete_own_projects}
                          onChange={(e) => setPermissions((p) => ({ ...p, members_can_delete_own_projects: e.target.checked }))}
                          className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                        />
                      </label>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Banter</h3>
                    <div className="space-y-3">
                      <label className="flex items-center justify-between">
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">Members can create channels</span>
                        <input
                          type="checkbox"
                          checked={permissions.members_can_create_channels}
                          onChange={(e) => setPermissions((p) => ({ ...p, members_can_create_channels: e.target.checked }))}
                          className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                        />
                      </label>
                      <label className="flex items-center justify-between">
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">Members can create private channels</span>
                        <input
                          type="checkbox"
                          checked={permissions.members_can_create_private_channels}
                          onChange={(e) => setPermissions((p) => ({ ...p, members_can_create_private_channels: e.target.checked }))}
                          className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                        />
                      </label>
                      <label className="flex items-center justify-between">
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">Members can create group DMs</span>
                        <input
                          type="checkbox"
                          checked={permissions.members_can_create_group_dms}
                          onChange={(e) => setPermissions((p) => ({ ...p, members_can_create_group_dms: e.target.checked }))}
                          className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                        />
                      </label>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Files</h3>
                    <label className="flex items-center justify-between gap-4">
                      <span className="text-sm text-zinc-700 dark:text-zinc-300">Max file upload size (MB)</span>
                      <Input
                        id="max-file-upload-mb"
                        type="number"
                        min={1}
                        max={1024}
                        value={permissions.max_file_upload_mb}
                        onChange={(e) => setPermissions((p) => ({ ...p, max_file_upload_mb: Math.max(1, parseInt(e.target.value, 10) || 1) }))}
                        className="w-24"
                      />
                    </label>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Invitations</h3>
                    <label className="flex items-center justify-between">
                      <span className="text-sm text-zinc-700 dark:text-zinc-300">Members can invite new members</span>
                      <input
                        type="checkbox"
                        checked={permissions.members_can_invite_members}
                        onChange={(e) => setPermissions((p) => ({ ...p, members_can_invite_members: e.target.checked }))}
                        className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                      />
                    </label>
                  </div>

                  <div>
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">API Keys</h3>
                    <div className="space-y-3">
                      <label className="flex items-center justify-between">
                        <span className="text-sm text-zinc-700 dark:text-zinc-300">Members can create API keys</span>
                        <input
                          type="checkbox"
                          checked={permissions.members_can_create_api_keys}
                          onChange={(e) => setPermissions((p) => ({ ...p, members_can_create_api_keys: e.target.checked }))}
                          className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                        />
                      </label>
                      <div>
                        <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-2">Allowed API key scopes for members</p>
                        <div className="flex flex-wrap gap-3">
                          {['read', 'read_write', 'admin'].map((scope) => (
                            <label key={scope} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                              <input
                                type="checkbox"
                                checked={permissions.allowed_api_key_scopes.includes(scope)}
                                onChange={() => toggleApiKeyScope(scope)}
                                className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                              />
                              <span>{scope}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </fieldset>

                {canEditPermissions && (
                  <div className="flex items-center gap-3 pt-2 border-t border-zinc-200 dark:border-zinc-800">
                    <Button onClick={handleSavePermissions} loading={permissionsSaving}>Save Permissions</Button>
                    {permissionsSaved && <span className="text-sm text-green-600">Saved!</span>}
                  </div>
                )}
              </div>
            )}
            {activeTab === 'launchpad' && (
              <OrgLaunchpadTab canEdit={canEditPermissions} />
            )}
            {activeTab === 'ai-providers' && (
              <SettingsLlmProviders />
            )}
            {activeTab === 'helpdesk' && (
              <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Helpdesk Settings</h2>
                  <p className="text-sm text-zinc-500">Configure the client-facing helpdesk portal.</p>
                </div>

                {/* Require email verification */}
                <label className="flex items-center justify-between">
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">Require email verification for helpdesk signups</span>
                  <input
                    type="checkbox"
                    checked={helpdeskRequireVerification}
                    onChange={(e) => setHelpdeskRequireVerification(e.target.checked)}
                    className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                  />
                </label>

                {/* Allowed email domains */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Allowed email domains</label>
                  <input
                    type="text"
                    placeholder="example.com, acme.org"
                    value={helpdeskAllowedDomains}
                    onChange={(e) => setHelpdeskAllowedDomains(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
                  />
                  <p className="text-xs text-zinc-400">Comma-separated. Leave blank to allow all domains.</p>
                </div>

                {/* Default project */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Default project for new tickets</label>
                  <select
                    value={helpdeskDefaultProject}
                    onChange={(e) => {
                      setHelpdeskDefaultProject(e.target.value);
                      setHelpdeskDefaultPhase('');
                    }}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
                  >
                    <option value="">-- Select Project --</option>
                    {helpdeskProjects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>

                {/* Default phase */}
                {helpdeskDefaultProject && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Default phase for new tickets</label>
                    <select
                      value={helpdeskDefaultPhase}
                      onChange={(e) => setHelpdeskDefaultPhase(e.target.value)}
                      className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100"
                    >
                      <option value="">-- Select Phase --</option>
                      {helpdeskPhases.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Welcome message */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Welcome message</label>
                  <textarea
                    placeholder="Welcome to our helpdesk! How can we help you today?"
                    value={helpdeskWelcomeMessage}
                    onChange={(e) => setHelpdeskWelcomeMessage(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100 resize-y"
                  />
                  <p className="text-xs text-zinc-400">Shown on the helpdesk portal landing page.</p>
                </div>

                {/* Ticket categories */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Ticket categories</label>
                  <textarea
                    placeholder={"Bug Report\nFeature Request\nBilling\nGeneral Inquiry"}
                    value={helpdeskCategories}
                    onChange={(e) => setHelpdeskCategories(e.target.value)}
                    rows={4}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100 resize-y"
                  />
                  <p className="text-xs text-zinc-400">One category per line.</p>
                </div>

                {/* Notification toggles */}
                <label className="flex items-center justify-between">
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">Notify client on status change</span>
                  <input
                    type="checkbox"
                    checked={helpdeskNotifyOnStatus}
                    onChange={(e) => setHelpdeskNotifyOnStatus(e.target.checked)}
                    className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                  />
                </label>

                <label className="flex items-center justify-between">
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">Notify client on agent reply</span>
                  <input
                    type="checkbox"
                    checked={helpdeskNotifyOnReply}
                    onChange={(e) => setHelpdeskNotifyOnReply(e.target.checked)}
                    className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
                  />
                </label>

                <div className="flex items-center gap-3">
                  <Button onClick={handleSaveHelpdeskSettings} loading={helpdeskSaving}>Save Settings</Button>
                  {helpdeskSaved && <span className="text-sm text-green-600">Saved!</span>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <PriorityManager open={priorityManagerOpen} onOpenChange={setPriorityManagerOpen} />
      {ftue && (
        <SettingsFtueTour
          setTab={(tab: SettingsTab) => setActiveTab(tab)}
          onComplete={() => onFtueComplete?.()}
        />
      )}
    </AppLayout>
  );
}

// ─── Tasks Tab ──────────────────────────────────────────────────────────────

interface TasksTabProps {
  onOpenPriorityManager: () => void;
}

function TasksTab({ onOpenPriorityManager }: TasksTabProps) {
  const { data: prioritiesRes, isLoading } = usePriorities();
  const rows = (prioritiesRes?.data ?? [])
    .slice()
    .sort((a, b) => a.position - b.position);

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Task Priorities</h2>
          <p className="text-sm text-zinc-500">
            Configure the priority levels available across this organization. Stored slug values
            stay constant when you rename, so changing a display label here does not move any tasks.
          </p>
        </div>
        <Button size="sm" onClick={onOpenPriorityManager}>
          <Pencil className="h-4 w-4" />
          Manage Priorities
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-zinc-400">Loading priorities…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-400">No priorities configured.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-3 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2"
            >
              <span
                className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
                style={priorityInlineStyle(row)}
              >
                {row.name}
              </span>
              <span className="text-xs text-zinc-500 font-mono" title="Stored slug">
                {row.value}
              </span>
              <span className="text-xs text-zinc-400 ml-auto">#{row.position}</span>
              {row.is_default && (
                <span className="text-[10px] uppercase tracking-wide font-medium text-yellow-600 dark:text-yellow-500">
                  default
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Org Launchpad Tab ──────────────────────────────────────────────────────

interface LaunchpadConfigResponse {
  data: {
    catalog: string[];
    org_override: string[] | null;
    platform_default: string[] | null;
  };
}

const ORG_LAUNCHPAD_APP_CATALOG: { id: string; name: string; description: string }[] = [
  { id: 'b3', name: 'Bam', description: 'Project Management' },
  { id: 'banter', name: 'Banter', description: 'Team Messaging' },
  { id: 'beacon', name: 'Beacon', description: 'Knowledge Base' },
  { id: 'bond', name: 'Bond', description: 'CRM' },
  { id: 'blast', name: 'Blast', description: 'Email Campaigns' },
  { id: 'bill', name: 'Bill', description: 'Invoicing' },
  { id: 'blank', name: 'Blank', description: 'Forms' },
  { id: 'book', name: 'Book', description: 'Scheduling' },
  { id: 'bench', name: 'Bench', description: 'Analytics' },
  { id: 'brief', name: 'Brief', description: 'Documents' },
  { id: 'bolt', name: 'Bolt', description: 'Automations' },
  { id: 'bearing', name: 'Bearing', description: 'Goals & OKRs' },
  { id: 'board', name: 'Board', description: 'Whiteboards' },
  { id: 'helpdesk', name: 'Helpdesk', description: 'Customer Support' },
];

function OrgLaunchpadTab({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['org', 'launchpad-apps'],
    queryFn: () => api.get<LaunchpadConfigResponse>('/org/launchpad-apps'),
  });

  const orgOverride = data?.data?.org_override ?? null;
  const platformDefault = data?.data?.platform_default ?? null;
  const platformAllows = new Set<string>(
    platformDefault ?? ORG_LAUNCHPAD_APP_CATALOG.map((a) => a.id),
  );

  const [draft, setDraft] = useState<string[] | null>(null);
  useEffect(() => {
    setDraft(orgOverride);
  }, [data]);

  const isOverride = draft !== null;
  const enabledSet = new Set<string>(
    isOverride ? (draft as string[]) : Array.from(platformAllows),
  );

  const save = useMutation({
    mutationFn: (apps: string[] | null) =>
      api.put<LaunchpadConfigResponse>('/org/launchpad-apps', { apps }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org', 'launchpad-apps'] });
    },
  });

  const toggleApp = (id: string) => {
    if (!isOverride) {
      // Switching from "inherit" → start with the platform-allowed set, minus this id.
      const seed = Array.from(platformAllows).filter((x) => x !== id);
      setDraft(seed);
      return;
    }
    const current = draft as string[];
    setDraft(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  };

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
          Launchpad apps
        </h2>
        <p className="text-sm text-zinc-500">
          Choose which apps appear in the Launchpad for everyone in your organization.
          Apps disabled at the platform level are shown greyed out — your org cannot
          enable apps that the platform has turned off.
        </p>
        {!canEdit && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            You need the admin or owner role to modify these settings.
          </p>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <fieldset disabled={!canEdit} className="space-y-4 disabled:opacity-60">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">Mode:</span>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className={`rounded-md px-2 py-1 text-xs ${
                !isOverride
                  ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              Inherit from platform
            </button>
            <button
              type="button"
              onClick={() => setDraft(orgOverride ?? Array.from(platformAllows))}
              className={`rounded-md px-2 py-1 text-xs ${
                isOverride
                  ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/40 dark:text-primary-300'
                  : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              Custom for this org
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ORG_LAUNCHPAD_APP_CATALOG.map((app) => {
              const platformDisabled = !platformAllows.has(app.id);
              const checked = enabledSet.has(app.id) && !platformDisabled;
              return (
                <label
                  key={app.id}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 transition-colors ${
                    platformDisabled
                      ? 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 opacity-50 cursor-not-allowed'
                      : checked
                        ? 'border-primary-300 bg-primary-50/50 dark:border-primary-700 dark:bg-primary-900/20 cursor-pointer'
                        : 'border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer'
                  } ${!isOverride && !platformDisabled ? 'opacity-70' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={platformDisabled || !isOverride}
                    onChange={() => toggleApp(app.id)}
                    className="rounded border-zinc-300 dark:border-zinc-700 text-primary-600 focus:ring-primary-500"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {app.name}
                    </div>
                    <div className="text-[11px] text-zinc-500 truncate">
                      {platformDisabled ? 'Disabled by platform admin' : app.description}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {canEdit && !isLoading && (
        <div className="flex items-center gap-3 pt-2 border-t border-zinc-200 dark:border-zinc-800">
          <Button
            onClick={() => save.mutate(draft)}
            loading={save.isPending}
            disabled={
              save.isPending ||
              JSON.stringify(draft ?? null) === JSON.stringify(orgOverride ?? null)
            }
          >
            Save changes
          </Button>
          {save.isSuccess && <span className="text-sm text-green-600">Saved!</span>}
          {save.isError && (
            <span className="text-sm text-red-600">
              Failed: {(save.error as Error).message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
