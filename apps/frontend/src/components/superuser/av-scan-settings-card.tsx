/**
 * SuperUser Console → Platform → Virus scanning.
 *
 * Platform-wide AV configuration for Bin uploads, backed by system_settings
 * av.* rows via /system-settings (SuperUser-gated on the server). The worker's
 * bin-av-scan job resolves these (apps/worker/src/utils/av-config.ts) with a
 * ~30s cache, falling back to the BIN_AV_SCAN_MODE / CLAMAV_* env vars — so a
 * change here takes effect within ~30s without a worker restart.
 *
 * av.allow_unscanned_access is the PLATFORM DEFAULT for "may a user work with a
 * file before its scan completes?"; each org can override it under its own
 * settings (Bin scan strip → admin toggle).
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';

type ScanMode = 'off' | 'eicar' | 'clamav';

interface SystemSettingRow {
  key: string;
  value: unknown;
}

interface AvDraft {
  scan_mode: ScanMode;
  clamav_host: string;
  clamav_port: number;
  allow_unscanned_access: boolean;
}

const DEFAULT_DRAFT: AvDraft = {
  scan_mode: 'eicar',
  clamav_host: '',
  clamav_port: 3310,
  allow_unscanned_access: false,
};

// Fetch a single setting key, tolerating 404 (never set) by returning null.
async function fetchSetting(key: string): Promise<unknown> {
  try {
    const res = await api.get<{ data: SystemSettingRow }>(`/system-settings/${key}`);
    return res.data?.value ?? null;
  } catch (err) {
    if ((err as { status?: number })?.status === 404) return null;
    throw err;
  }
}

export function AvScanSettingsCard() {
  const queryClient = useQueryClient();

  const { data: loaded, isLoading } = useQuery({
    queryKey: ['system-settings', 'av'],
    queryFn: async (): Promise<Partial<AvDraft>> => {
      const [mode, host, port, allow] = await Promise.all([
        fetchSetting('av.scan_mode'),
        fetchSetting('av.clamav_host'),
        fetchSetting('av.clamav_port'),
        fetchSetting('av.allow_unscanned_access'),
      ]);
      return {
        scan_mode: mode === 'off' || mode === 'eicar' || mode === 'clamav' ? mode : undefined,
        clamav_host: typeof host === 'string' ? host : undefined,
        clamav_port:
          typeof port === 'number' ? port : typeof port === 'string' ? Number(port) : undefined,
        allow_unscanned_access: typeof allow === 'boolean' ? allow : undefined,
      };
    },
  });

  const [draft, setDraft] = useState<AvDraft>(DEFAULT_DRAFT);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !loaded) return;
    setDraft({ ...DEFAULT_DRAFT, ...clean(loaded) });
    setSeeded(true);
  }, [loaded, seeded]);

  const saveMutation = useMutation({
    mutationFn: async (d: AvDraft) => {
      await api.put('/system-settings/av.scan_mode', { value: d.scan_mode });
      await api.put('/system-settings/av.clamav_host', {
        value: d.clamav_host.trim() === '' ? null : d.clamav_host.trim(),
      });
      await api.put('/system-settings/av.clamav_port', { value: d.clamav_port });
      await api.put('/system-settings/av.allow_unscanned_access', {
        value: d.allow_unscanned_access,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-settings', 'av'] });
    },
  });

  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
          <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Virus scanning</h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            How Bin scans uploaded files before serving them. Applies to every
            organization on this install; the worker picks up changes within
            ~30 seconds. Overrides the <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1 text-xs">BIN_AV_SCAN_MODE</code> / <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1 text-xs">CLAMAV_*</code> env vars.
          </p>

          {isLoading ? (
            <div className="mt-6 flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              {/* Scan mode */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">
                  Scan mode
                </label>
                <div className="flex flex-wrap gap-2">
                  <ModeButton
                    active={draft.scan_mode === 'eicar'}
                    onClick={() => setDraft((d) => ({ ...d, scan_mode: 'eicar' }))}
                    label="Built-in (EICAR)"
                    hint="Dependency-free signature scan"
                  />
                  <ModeButton
                    active={draft.scan_mode === 'clamav'}
                    onClick={() => setDraft((d) => ({ ...d, scan_mode: 'clamav' }))}
                    label="ClamAV"
                    hint="Stream to a clamd endpoint"
                  />
                  <ModeButton
                    active={draft.scan_mode === 'off'}
                    onClick={() => setDraft((d) => ({ ...d, scan_mode: 'off' }))}
                    label="Off"
                    hint="Mark everything skipped"
                  />
                </div>
              </div>

              {/* ClamAV endpoint (only relevant in clamav mode) */}
              {draft.scan_mode === 'clamav' && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      ClamAV host
                    </label>
                    <input
                      type="text"
                      value={draft.clamav_host}
                      onChange={(e) => setDraft((d) => ({ ...d, clamav_host: e.target.value }))}
                      placeholder="clamav"
                      className="mt-1 w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      Port
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={draft.clamav_port}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, clamav_port: Number(e.target.value) || 3310 }))
                      }
                      className="mt-1 w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm font-mono"
                    />
                  </div>
                </div>
              )}

              {/* Allow unscanned access (platform default) */}
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={draft.allow_unscanned_access}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, allow_unscanned_access: e.target.checked }))
                  }
                  className="mt-0.5 rounded border-zinc-300 dark:border-zinc-700 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-sm text-zinc-900 dark:text-zinc-100">
                  Allow working with files before the scan completes
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                    Platform default. Users can acknowledge the risk and open a
                    still-scanning or errored file. Each org can override this.
                    Infected files stay blocked for everyone but admins.
                  </span>
                </span>
              </label>

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
                  Save
                </button>
                {saveMutation.isSuccess && (
                  <span className="text-xs text-green-600 dark:text-green-400">
                    Saved. The worker applies it within ~30 seconds.
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

// Drop undefined keys so a partial load only overrides what was actually set.
function clean(partial: Partial<AvDraft>): Partial<AvDraft> {
  const out: Partial<AvDraft> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

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
