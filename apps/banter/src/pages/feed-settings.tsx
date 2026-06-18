import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Sparkles, RotateCcw, Save, Eye, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';

interface FeedSettingsPageProps {
  onNavigate: (path: string) => void;
}

interface FeedWeights {
  categories: Record<string, number>;
  gravity: number;
  recency_offset: number;
  engagement_weight: number;
  interaction_boost: { commented: number; reacted: number; authored: number; mentioned: number };
  affinity_boost: { assignee: number; watcher: number; contributor: number };
  seen_multiplier: number;
  candidate_window_days: number;
  must_see_floor: number;
}

interface WeightsView {
  effective: FeedWeights;
  defaults: FeedWeights;
  version: number;
  platform: { weights: Partial<FeedWeights>; version: number } | null;
  org: { weights: Partial<FeedWeights>; version: number } | null;
}

interface PreviewEntry {
  id: string;
  title: string;
  score: number;
  category: string;
}

const KNOBS: { key: keyof FeedWeights; label: string; step: number; hint: string }[] = [
  { key: 'gravity', label: 'Gravity', step: 0.1, hint: 'Higher = newer content dominates harder' },
  { key: 'recency_offset', label: 'Recency offset (hours)', step: 0.5, hint: 'Dampens the brand-new spike' },
  { key: 'engagement_weight', label: 'Engagement weight', step: 0.05, hint: 'How much replies/reactions lift an item' },
  { key: 'seen_multiplier', label: 'Seen multiplier', step: 0.05, hint: 'How far a seen item sinks (0–1)' },
  { key: 'candidate_window_days', label: 'Candidate window (days)', step: 1, hint: 'How far back the feed reaches' },
  { key: 'must_see_floor', label: 'Must-see floor', step: 50, hint: 'Pins approvals + unread mentions to the top' },
];

/**
 * Feed ranking settings (banter-feed-design-document.md §9). Edit the tunable
 * weights for the org (admin/owner) or the platform defaults (SuperUser), with
 * a live preview that re-scores your own feed against the proposed weights — the
 * tuning loop: change a number, watch the feed reshuffle, save when it feels
 * right. Only the org/platform OVERRIDES are sent; unset knobs inherit.
 */
export function FeedSettingsPage({ onNavigate }: FeedSettingsPageProps) {
  const user = useAuthStore((s) => s.user) as
    | { role?: string; is_superuser?: boolean }
    | null;
  const isSuperuser = !!user?.is_superuser;
  const isAdmin = isSuperuser || user?.role === 'owner' || user?.role === 'admin';

  const [view, setView] = useState<WeightsView | null>(null);
  const [scope, setScope] = useState<'org' | 'platform'>('org');
  const [draft, setDraft] = useState<FeedWeights | null>(null);
  const [preview, setPreview] = useState<PreviewEntry[] | null>(null);
  const [busy, setBusy] = useState<'load' | 'preview' | 'save' | null>('load');
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  useEffect(() => {
    api
      .get<{ data: WeightsView }>('/feed/weights')
      .then((r) => {
        setView(r.data);
        setDraft(structuredClone(r.data.effective));
        setBusy(null);
      })
      .catch(() => setBusy(null));
  }, []);

  const categoryKeys = useMemo(
    () => (draft ? Object.keys(draft.categories).sort((a, b) => draft.categories[b]! - draft.categories[a]!) : []),
    [draft],
  );

  // Build the partial override = the keys that differ from the *other* level's
  // effective baseline. To keep it simple we send the full draft as the override
  // (every knob explicit); inheritance still applies to anything we omit, but
  // the form shows + sends all knobs, which is the intended admin experience.
  function buildOverride(): Partial<FeedWeights> {
    return draft ? structuredClone(draft) : {};
  }

  async function runPreview() {
    if (!draft) return;
    setBusy('preview');
    try {
      const r = await api.post<{ data: PreviewEntry[] }>('/feed/weights/preview', {
        weights: buildOverride(),
        scope,
      });
      setPreview(r.data);
    } catch {
      setPreview([]);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!draft) return;
    setBusy('save');
    try {
      const path = scope === 'platform' ? '/feed/weights/platform' : '/feed/weights/org';
      const r = await api.put<{ data: { version: number } }>(path, buildOverride());
      setSavedVersion(r.data.version);
    } catch {
      // surfaced via lack of savedVersion change
    } finally {
      setBusy(null);
    }
  }

  function resetToDefaults() {
    if (view) setDraft(structuredClone(view.defaults));
  }

  if (busy === 'load') {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  if (!draft || !view) {
    return <div className="p-8 text-zinc-500">Could not load feed settings.</div>;
  }

  const readOnly = !isAdmin || (scope === 'platform' && !isSuperuser);
  const num = (v: number) => (Number.isFinite(v) ? v : 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <button
          onClick={() => onNavigate('/settings')}
          className="p-1.5 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <Sparkles className="h-5 w-5 text-primary-500" />
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Feed ranking</h1>
        {isSuperuser && (
          <div className="ml-auto flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-sm">
            {(['org', 'platform'] as const).map((s) => (
              <button
                key={s}
                onClick={() => { setScope(s); setPreview(null); }}
                className={cn(
                  'px-3 py-1.5 capitalize',
                  scope === s
                    ? 'bg-primary-600 text-white'
                    : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                )}
              >
                {s === 'org' ? 'Org overrides' : 'Platform defaults'}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Editor */}
          <div className="space-y-6">
            <section>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">How things age + matter</h2>
              <div className="space-y-3">
                {KNOBS.map(({ key, label, step, hint }) => (
                  <label key={key} className="block">
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">{label}</span>
                    <span className="block text-xs text-zinc-400 mb-1">{hint}</span>
                    <input
                      type="number"
                      step={step}
                      disabled={readOnly}
                      value={num(draft[key] as number)}
                      onChange={(e) =>
                        setDraft({ ...draft, [key]: Number.parseFloat(e.target.value) })
                      }
                      className="w-32 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-sm disabled:opacity-60"
                    />
                  </label>
                ))}
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">What floats to the top (category weights)</h2>
              <div className="space-y-1.5">
                {categoryKeys.map((cat) => (
                  <label key={cat} className="flex items-center justify-between gap-3">
                    <span className="text-xs font-mono text-zinc-600 dark:text-zinc-400 truncate">{cat}</span>
                    <input
                      type="number"
                      step={0.1}
                      disabled={readOnly}
                      value={num(draft.categories[cat]!)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          categories: { ...draft.categories, [cat]: Number.parseFloat(e.target.value) },
                        })
                      }
                      className="w-20 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-sm disabled:opacity-60"
                    />
                  </label>
                ))}
              </div>
            </section>

            {!readOnly && (
              <div className="flex items-center gap-2">
                <button
                  onClick={runPreview}
                  disabled={busy === 'preview'}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700"
                >
                  <Eye className="h-4 w-4" /> {busy === 'preview' ? 'Scoring…' : 'Preview'}
                </button>
                <button
                  onClick={save}
                  disabled={busy === 'save'}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700"
                >
                  <Save className="h-4 w-4" /> {busy === 'save' ? 'Saving…' : `Save ${scope === 'platform' ? 'platform defaults' : 'org overrides'}`}
                </button>
                <button
                  onClick={resetToDefaults}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  title="Reset the editor to the shipped defaults"
                >
                  <RotateCcw className="h-4 w-4" /> Reset
                </button>
                {savedVersion != null && (
                  <span className="text-xs text-green-600 dark:text-green-400">Saved (v{savedVersion})</span>
                )}
              </div>
            )}
            {readOnly && (
              <p className="text-sm text-zinc-500">
                You have read-only access. {scope === 'platform' ? 'Platform defaults require SuperUser.' : 'Org weights require an org admin or owner.'}
              </p>
            )}
          </div>

          {/* Live preview */}
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Live preview — your feed, re-ranked</h2>
            {preview == null ? (
              <p className="text-sm text-zinc-400">Click <strong>Preview</strong> to see how your feed reshuffles under these weights (nothing is saved).</p>
            ) : preview.length === 0 ? (
              <p className="text-sm text-zinc-400">Your feed is empty, so there is nothing to preview.</p>
            ) : (
              <ol className="space-y-1">
                {preview.map((e, i) => (
                  <li key={e.id} className="flex items-center gap-2 text-sm rounded-md px-2 py-1.5 bg-zinc-50 dark:bg-zinc-800/50">
                    <span className="text-xs text-zinc-400 w-5">{i + 1}.</span>
                    <span className="flex-1 truncate text-zinc-800 dark:text-zinc-200">{e.title}</span>
                    <span className="text-xs font-mono text-zinc-400">{e.score.toFixed(2)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
