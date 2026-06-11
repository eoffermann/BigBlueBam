/**
 * SuperUser-only platform setting: how the server generates passwords
 * for admin-issued resets, the CLI reset-password command, and any other
 * server-side mint. Backed by system_settings.password_policy and the
 * shared password-generator.service on the api side.
 *
 * The UI exposes:
 *  - Mode (alphanumeric / passphrase)
 *  - Mode-specific knobs (length, word count, separator, etc.)
 *  - A live "What it'll look like" preview generated server-side via
 *    POST /system-settings/password_policy/preview so the operator sees
 *    actual samples from the real generator (no client-side
 *    re-implementation that could drift).
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, RefreshCw, Save } from 'lucide-react';
import { api } from '@/lib/api';

interface AlphanumericPolicy {
  length: number;
}

interface PassphrasePolicy {
  word_count: number;
  separator: string;
  capitalize_words: boolean;
  digit_count: number;
  append_symbol: boolean;
}

interface PasswordPolicy {
  mode: 'alphanumeric' | 'passphrase';
  alphanumeric: AlphanumericPolicy;
  passphrase: PassphrasePolicy;
}

const DEFAULT_POLICY: PasswordPolicy = {
  mode: 'alphanumeric',
  alphanumeric: { length: 16 },
  passphrase: {
    word_count: 4,
    separator: '-',
    capitalize_words: true,
    digit_count: 2,
    append_symbol: true,
  },
};

interface SystemSettingRow {
  key: string;
  value: unknown;
  updated_at?: string;
}

interface PreviewResponse {
  data: {
    policy: PasswordPolicy;
    samples: string[];
  };
}

export function PasswordPolicyCard() {
  const queryClient = useQueryClient();

  const { data: currentRow, isLoading } = useQuery({
    queryKey: ['system-settings', 'password_policy'],
    queryFn: async () => {
      try {
        return await api.get<{ data: SystemSettingRow }>(
          '/system-settings/password_policy',
        );
      } catch (err) {
        // 404 = no policy ever set — fall back to default. Anything else
        // bubbles up so the React Query error UI fires.
        if ((err as { status?: number })?.status === 404) {
          return { data: { key: 'password_policy', value: null } } as {
            data: SystemSettingRow;
          };
        }
        throw err;
      }
    },
  });

  // Draft policy the user is editing. Seeded from the loaded row once it
  // arrives, then drives the form and the preview.
  const [draft, setDraft] = useState<PasswordPolicy>(DEFAULT_POLICY);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !currentRow) return;
    const raw = currentRow.data?.value;
    if (raw && typeof raw === 'object') {
      setDraft({ ...DEFAULT_POLICY, ...(raw as Partial<PasswordPolicy>) });
    }
    setSeeded(true);
  }, [currentRow, seeded]);

  // Preview lives server-side so the actual generator is the source of
  // truth. Mutation-as-query so we can manually re-fire on form changes.
  const previewMutation = useMutation({
    mutationFn: (policy: PasswordPolicy) =>
      api.post<PreviewResponse>('/system-settings/password_policy/preview', {
        policy,
        count: 5,
      }),
  });

  // Auto-refresh the preview when the user adjusts the form. A short
  // debounce keeps the request volume sane while still feeling live.
  const draftKey = useMemo(() => JSON.stringify(draft), [draft]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      previewMutation.mutate(draft);
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const saveMutation = useMutation({
    mutationFn: (policy: PasswordPolicy) =>
      api.put<{ data: SystemSettingRow }>('/system-settings/password_policy', {
        value: policy,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-settings', 'password_policy'] });
    },
  });

  const samples = previewMutation.data?.data?.samples ?? [];

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-100 dark:bg-primary-900/30">
          <KeyRound className="h-5 w-5 text-primary-600 dark:text-primary-400" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Generated-password style
          </h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            How the server fills in passwords for admin-issued resets and
            the CLI <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1 text-xs">reset-password</code> command
            when no explicit password is supplied. Affects every
            organization on this install.
          </p>

          {isLoading ? (
            <div className="mt-6 flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              {/* Mode selector */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">
                  Style
                </label>
                <div className="flex flex-wrap gap-2">
                  <ModeButton
                    active={draft.mode === 'alphanumeric'}
                    onClick={() => setDraft((d) => ({ ...d, mode: 'alphanumeric' }))}
                    label="Random characters"
                    hint="Confusable-safe alphabet"
                  />
                  <ModeButton
                    active={draft.mode === 'passphrase'}
                    onClick={() => setDraft((d) => ({ ...d, mode: 'passphrase' }))}
                    label="Passphrase"
                    hint="Several short words"
                  />
                </div>
              </div>

              {/* Mode-specific knobs */}
              {draft.mode === 'alphanumeric' ? (
                <AlphanumericKnobs
                  policy={draft.alphanumeric}
                  onChange={(alphanumeric) => setDraft((d) => ({ ...d, alphanumeric }))}
                />
              ) : (
                <PassphraseKnobs
                  policy={draft.passphrase}
                  onChange={(passphrase) => setDraft((d) => ({ ...d, passphrase }))}
                />
              )}

              {/* Live preview */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    What it'll look like
                  </label>
                  <button
                    type="button"
                    onClick={() => previewMutation.mutate(draft)}
                    disabled={previewMutation.isPending}
                    className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={
                        'h-3.5 w-3.5 ' +
                        (previewMutation.isPending ? 'animate-spin' : '')
                      }
                    />
                    Refresh
                  </button>
                </div>
                <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 space-y-1.5 font-mono text-sm text-zinc-900 dark:text-zinc-100">
                  {samples.length === 0 && (
                    <div className="text-zinc-500 italic font-sans text-xs">
                      Generating samples…
                    </div>
                  )}
                  {samples.map((s, i) => (
                    <div key={i} className="truncate">
                      {s}
                    </div>
                  ))}
                </div>
                {previewMutation.isError && (
                  <p className="mt-2 text-xs text-red-600 dark:text-red-400">
                    Preview failed: {(previewMutation.error as Error).message}
                  </p>
                )}
              </div>

              {/* Save */}
              <div className="flex items-center gap-3 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => saveMutation.mutate(draft)}
                  disabled={saveMutation.isPending}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save policy
                </button>
                {saveMutation.isSuccess && (
                  <span className="text-xs text-green-600 dark:text-green-400">
                    Saved. Applies to the next generated password.
                  </span>
                )}
                {saveMutation.isError && (
                  <span className="text-xs text-red-600 dark:text-red-400">
                    {(saveMutation.error as Error).message}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ─── sub-components ────────────────────────────────────────────────────

function ModeButton({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex flex-col items-start gap-0.5 px-4 py-2.5 rounded-md border text-left transition-colors ' +
        (active
          ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20 text-primary-900 dark:text-primary-100'
          : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 hover:border-zinc-300 dark:hover:border-zinc-700')
      }
    >
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs opacity-70">{hint}</span>
    </button>
  );
}

function AlphanumericKnobs({
  policy,
  onChange,
}: {
  policy: AlphanumericPolicy;
  onChange: (p: AlphanumericPolicy) => void;
}) {
  return (
    <div>
      <label
        htmlFor="pw-length"
        className="flex items-baseline justify-between text-sm font-medium text-zinc-900 dark:text-zinc-100"
      >
        <span>Length</span>
        <span className="text-zinc-500 dark:text-zinc-400">
          {policy.length} characters
        </span>
      </label>
      <input
        id="pw-length"
        type="range"
        min={12}
        max={64}
        step={1}
        value={policy.length}
        onChange={(e) => onChange({ length: Number(e.target.value) })}
        className="mt-2 w-full"
      />
      <div className="mt-1 flex justify-between text-xs text-zinc-500">
        <span>12</span>
        <span>64</span>
      </div>
    </div>
  );
}

function PassphraseKnobs({
  policy,
  onChange,
}: {
  policy: PassphrasePolicy;
  onChange: (p: PassphrasePolicy) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label className="flex items-baseline justify-between text-sm font-medium text-zinc-900 dark:text-zinc-100">
          <span>Word count</span>
          <span className="text-zinc-500 dark:text-zinc-400">{policy.word_count}</span>
        </label>
        <input
          type="range"
          min={3}
          max={8}
          step={1}
          value={policy.word_count}
          onChange={(e) => onChange({ ...policy, word_count: Number(e.target.value) })}
          className="mt-2 w-full"
        />
        <div className="mt-1 flex justify-between text-xs text-zinc-500">
          <span>3 (~30 bits)</span>
          <span>8 (~80 bits)</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Separator
          </label>
          <input
            type="text"
            maxLength={3}
            value={policy.separator}
            onChange={(e) => onChange({ ...policy, separator: e.target.value })}
            placeholder="-"
            className="mt-1 w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm font-mono"
          />
          <p className="mt-1 text-xs text-zinc-500">
            Empty for run-together (HelloWorldRiver42)
          </p>
        </div>
        <div>
          <label className="flex items-baseline justify-between text-sm font-medium text-zinc-900 dark:text-zinc-100">
            <span>Trailing digits</span>
            <span className="text-zinc-500 dark:text-zinc-400">{policy.digit_count}</span>
          </label>
          <input
            type="range"
            min={0}
            max={4}
            step={1}
            value={policy.digit_count}
            onChange={(e) => onChange({ ...policy, digit_count: Number(e.target.value) })}
            className="mt-2 w-full"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <Checkbox
          label="Capitalize each word"
          checked={policy.capitalize_words}
          onChange={(v) => onChange({ ...policy, capitalize_words: v })}
        />
        <Checkbox
          label="Append a symbol"
          checked={policy.append_symbol}
          onChange={(v) => onChange({ ...policy, append_symbol: v })}
        />
      </div>
    </div>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer text-sm text-zinc-900 dark:text-zinc-100">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-zinc-300 dark:border-zinc-700 text-primary-600 focus:ring-primary-500"
      />
      {label}
    </label>
  );
}
