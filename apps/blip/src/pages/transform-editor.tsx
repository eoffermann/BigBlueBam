import { useEffect, useState } from 'react';
import { ShieldAlert, Plus, Trash2, Loader2, Save } from 'lucide-react';
import {
  useTransform,
  useSetTransform,
  type TransformRule,
  type TransformAction,
} from '@/hooks/use-blip';

interface TransformEditorPageProps {
  appId: string;
}

const ACTIONS: TransformAction[] = ['drop', 'mask', 'hash', 'truncate'];

const emptyRule = (): TransformRule => ({ match: '', action: 'mask', params: {} });

export function TransformEditorPage({ appId }: TransformEditorPageProps) {
  const { data, isLoading } = useTransform(appId);
  const save = useSetTransform(appId);

  const [enabled, setEnabled] = useState(true);
  const [rules, setRules] = useState<TransformRule[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data?.data) {
      setEnabled(data.data.enabled);
      setRules(data.data.rules ?? []);
    }
  }, [data]);

  const update = (i: number, patch: Partial<TransformRule>) =>
    setRules((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <ShieldAlert className="h-6 w-6 text-primary-500" />
          PII transform
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Ordered redaction rules applied at the edge, before tail and durable write — no un-redacted
          field ever leaves the request thread. Match by explicit field path, <code className="font-mono">glob:</code>,
          or <code className="font-mono">regex:</code>.
        </p>
      </div>

      {isLoading ? (
        <div className="text-sm text-zinc-500 flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Transform enabled
          </label>

          <div className="space-y-2">
            {rules.length === 0 && (
              <div className="text-sm text-zinc-500">
                No rules. A global per-string length cap always applies as a floor regardless.
              </div>
            )}
            {rules.map((rule, i) => (
              <div
                key={i}
                className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3"
              >
                <div className="flex flex-col flex-1 min-w-[200px]">
                  <label className="text-xs text-zinc-500 mb-1">Match</label>
                  <input
                    value={rule.match}
                    onChange={(e) => update(i, { match: e.target.value })}
                    placeholder="payload:user.email or glob:*token*"
                    className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm font-mono"
                  />
                </div>
                <div className="flex flex-col">
                  <label className="text-xs text-zinc-500 mb-1">Action</label>
                  <select
                    value={rule.action}
                    onChange={(e) => update(i, { action: e.target.value as TransformAction })}
                    className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm"
                  >
                    {ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
                {rule.action === 'mask' && (
                  <div className="flex flex-col">
                    <label className="text-xs text-zinc-500 mb-1">keep_last</label>
                    <input
                      type="number"
                      value={rule.params?.keep_last ?? ''}
                      onChange={(e) =>
                        update(i, { params: { ...rule.params, keep_last: Number(e.target.value) } })
                      }
                      className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-20"
                    />
                  </div>
                )}
                {rule.action === 'truncate' && (
                  <div className="flex flex-col">
                    <label className="text-xs text-zinc-500 mb-1">max_len</label>
                    <input
                      type="number"
                      value={rule.params?.max_len ?? ''}
                      onChange={(e) =>
                        update(i, { params: { ...rule.params, max_len: Number(e.target.value) } })
                      }
                      className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm w-24"
                    />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setRules((rs) => rs.filter((_, idx) => idx !== i))}
                  className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-900/50 px-2 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRules((rs) => [...rs, emptyRule()])}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-200"
            >
              <Plus className="h-4 w-4" /> Add rule
            </button>
            <button
              type="button"
              disabled={save.isPending}
              onClick={() =>
                save.mutate(
                  { enabled, rules },
                  {
                    onSuccess: () => {
                      setSaved(true);
                      setTimeout(() => setSaved(false), 2000);
                    },
                  },
                )
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
            >
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saved ? 'Saved' : 'Save rules'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
