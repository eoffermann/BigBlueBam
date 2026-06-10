import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiResponse } from '@bigbluebam/shared';
import { Dialog } from '@/components/common/dialog';
import { Button } from '@/components/common/button';
import { api } from '@/lib/api';

/**
 * Per-project calling settings — Bureau prerequisite P-4.
 *
 * Each knob has two modes:
 *   - "Inherit" (NULL in the DB): take whatever the org or platform says
 *   - "Override": pin an explicit boolean on this project
 *
 * Reads:
 *   GET /projects/:id/calling-settings           — raw row (NULL = inherit)
 *   GET /projects/:id/calling-settings/effective — resolved values + source
 * Writes:
 *   PUT /projects/:id/calling-settings           — admin/owner only
 */

interface CallingSettingsRow {
  project_id: string;
  org_id: string;
  calling_enabled: boolean | null;
  allow_recording: boolean | null;
  allow_transcription: boolean | null;
  default_office_privacy: string | null;
  created_at: string;
  updated_at: string;
}

interface EffectiveCallingSettings {
  calling_enabled: boolean;
  allow_recording: boolean;
  allow_transcription: boolean;
  default_office_privacy: string;
  source: {
    calling_enabled: 'project' | 'org' | 'platform';
    allow_recording: 'project' | 'org' | 'platform';
    allow_transcription: 'project' | 'org' | 'platform';
    default_office_privacy: 'project' | 'org' | 'platform';
  };
}

interface CallingSettingsManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

type Tri = 'inherit' | 'on' | 'off';

const PRIVACY_OPTIONS = [
  { value: '', label: 'Inherit' },
  { value: 'public', label: 'Public' },
  { value: 'org', label: 'Org-wide' },
  { value: 'private', label: 'Private' },
];

function rowToTri(v: boolean | null | undefined): Tri {
  if (v === true) return 'on';
  if (v === false) return 'off';
  return 'inherit';
}

function triToRow(t: Tri): boolean | null {
  if (t === 'on') return true;
  if (t === 'off') return false;
  return null;
}

function sourceLabel(s: 'project' | 'org' | 'platform'): string {
  if (s === 'project') return 'project override';
  if (s === 'org') return 'inherited from org';
  return 'inherited from platform';
}

export function CallingSettingsManager({
  open,
  onOpenChange,
  projectId,
}: CallingSettingsManagerProps) {
  const queryClient = useQueryClient();

  const { data: rowRes } = useQuery({
    queryKey: ['project-calling-settings', projectId],
    queryFn: () =>
      api.get<{ data: CallingSettingsRow | null }>(
        `/projects/${projectId}/calling-settings`,
      ),
    enabled: !!projectId && open,
  });
  const { data: effectiveRes } = useQuery({
    queryKey: ['project-calling-settings', projectId, 'effective'],
    queryFn: () =>
      api.get<{ data: EffectiveCallingSettings }>(
        `/projects/${projectId}/calling-settings/effective`,
      ),
    enabled: !!projectId && open,
  });

  const row = rowRes?.data ?? null;
  const effective = effectiveRes?.data ?? null;

  const [callingEnabled, setCallingEnabled] = useState<Tri>('inherit');
  const [allowRecording, setAllowRecording] = useState<Tri>('inherit');
  const [allowTranscription, setAllowTranscription] = useState<Tri>('inherit');
  const [defaultPrivacy, setDefaultPrivacy] = useState<string>('');

  // Sync local state once the fetched row arrives.
  useEffect(() => {
    if (!open) return;
    setCallingEnabled(rowToTri(row?.calling_enabled));
    setAllowRecording(rowToTri(row?.allow_recording));
    setAllowTranscription(rowToTri(row?.allow_transcription));
    setDefaultPrivacy(row?.default_office_privacy ?? '');
  }, [open, row]);

  const save = useMutation({
    mutationFn: (body: {
      calling_enabled: boolean | null;
      allow_recording: boolean | null;
      allow_transcription: boolean | null;
      default_office_privacy: string | null;
    }) =>
      api.put<ApiResponse<CallingSettingsRow>>(
        `/projects/${projectId}/calling-settings`,
        body,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['project-calling-settings', projectId],
      });
    },
  });

  const handleSave = () => {
    save.mutate({
      calling_enabled: triToRow(callingEnabled),
      allow_recording: triToRow(allowRecording),
      allow_transcription: triToRow(allowTranscription),
      default_office_privacy: defaultPrivacy.length > 0 ? defaultPrivacy : null,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Calling Settings"
      description="Override calling behavior for this project. Leave any setting on 'Inherit' to take the org default."
      className="max-w-xl"
    >
      <div className="space-y-5">
        <TriRow
          label="Calling enabled"
          help="Master switch. Turn off to forbid call rooms for this project regardless of org policy."
          value={callingEnabled}
          onChange={setCallingEnabled}
          effective={effective?.calling_enabled}
          source={effective?.source.calling_enabled}
        />
        <TriRow
          label="Allow recording"
          help="Permit audio/video recording of calls in this project."
          value={allowRecording}
          onChange={setAllowRecording}
          effective={effective?.allow_recording}
          source={effective?.source.allow_recording}
        />
        <TriRow
          label="Allow transcription"
          help="Permit speech-to-text transcription of calls."
          value={allowTranscription}
          onChange={setAllowTranscription}
          effective={effective?.allow_transcription}
          source={effective?.source.allow_transcription}
        />

        <div>
          <div className="flex items-baseline justify-between">
            <label
              htmlFor="default-office-privacy"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Default office privacy
            </label>
            {effective?.source.default_office_privacy && (
              <span className="text-[11px] text-zinc-400">
                Effective: <span className="font-medium">{effective.default_office_privacy}</span>{' '}
                ({sourceLabel(effective.source.default_office_privacy)})
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">
            Reserved for Bureau. Sets the default privacy of new per-project rooms.
          </p>
          <select
            id="default-office-privacy"
            value={defaultPrivacy}
            onChange={(e) => setDefaultPrivacy(e.target.value)}
            className="w-full px-2 py-1.5 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-primary-500"
          >
            {PRIVACY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-zinc-200 dark:border-zinc-700">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} loading={save.isPending}>
            Save
          </Button>
        </div>

        {save.isError && (
          <p className="text-xs text-red-600">
            Failed to save calling settings. You may not have admin role on this project.
          </p>
        )}
      </div>
    </Dialog>
  );
}

interface TriRowProps {
  label: string;
  help: string;
  value: Tri;
  onChange: (v: Tri) => void;
  effective: boolean | undefined;
  source: 'project' | 'org' | 'platform' | undefined;
}

function TriRow({ label, help, value, onChange, effective, source }: TriRowProps) {
  const radioName = `calling-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
        {source && typeof effective === 'boolean' && (
          <span className="text-[11px] text-zinc-400">
            Effective: <span className="font-medium">{effective ? 'on' : 'off'}</span> (
            {sourceLabel(source)})
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1.5">{help}</p>
      <div className="flex gap-3 text-sm">
        {(['inherit', 'on', 'off'] as const).map((opt) => (
          <label key={opt} className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name={radioName}
              checked={value === opt}
              onChange={() => onChange(opt)}
              className="accent-primary-500"
            />
            <span className="capitalize text-zinc-700 dark:text-zinc-300">
              {opt === 'inherit' ? 'Inherit from org' : opt === 'on' ? 'Override on' : 'Override off'}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
