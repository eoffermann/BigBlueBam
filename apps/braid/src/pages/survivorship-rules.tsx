import { useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Plus, Save, SlidersHorizontal } from 'lucide-react';
import {
  useSurvivorshipRules,
  useSetSurvivorshipRule,
  BRAID_SOURCE_TYPES,
  BRAID_SURVIVORSHIP_STRATEGIES,
  type BraidSurvivorshipStrategyT,
} from '@/hooks/use-braid';
import type { BraidSourceType } from '@bigbluebam/shared';

const DEFAULT_FIELDS: Record<'person' | 'company', string[]> = {
  person: ['display_name', 'primary_email', 'primary_phone'],
  company: ['display_name', 'primary_email', 'primary_phone'],
};

const STRATEGY_LABELS: Record<BraidSurvivorshipStrategyT, string> = {
  most_recent: 'Most recent value wins',
  source_priority: 'Source priority order',
  longest_non_null: 'Longest non-null value',
  most_frequent: 'Most frequent value',
  manual_pin: 'Manually pinned value',
};

interface RuleEditorProps {
  kind: 'person' | 'company';
  field: string;
  existing: {
    strategy: BraidSurvivorshipStrategyT;
    source_priority: BraidSourceType[];
    pinned_value?: unknown;
  } | null;
}

function RuleEditor({ kind, field, existing }: RuleEditorProps) {
  const setRule = useSetSurvivorshipRule();
  const [strategy, setStrategy] = useState<BraidSurvivorshipStrategyT>(existing?.strategy ?? 'most_recent');
  const [sourcePriority, setSourcePriority] = useState<BraidSourceType[]>(existing?.source_priority ?? []);
  const [pinnedValue, setPinnedValue] = useState<string>(
    existing?.pinned_value != null ? String(existing.pinned_value) : '',
  );
  const [saved, setSaved] = useState(false);

  function moveSource(index: number, dir: -1 | 1) {
    setSourcePriority((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function toggleSource(src: BraidSourceType) {
    setSourcePriority((prev) => (prev.includes(src) ? prev.filter((s) => s !== src) : [...prev, src]));
  }

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="font-mono text-sm text-zinc-900 dark:text-zinc-100">{field}</span>
        <select
          value={strategy}
          onChange={(e) => setStrategy(e.target.value as BraidSurvivorshipStrategyT)}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1 text-xs"
        >
          {BRAID_SURVIVORSHIP_STRATEGIES.map((s) => (
            <option key={s} value={s}>
              {STRATEGY_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {strategy === 'source_priority' && (
        <div className="mb-2">
          <p className="text-xs text-zinc-500 mb-1.5">
            Check sources to include, then order them highest priority first.
          </p>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {BRAID_SOURCE_TYPES.map((src) => (
              <label
                key={src}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 text-zinc-600 dark:text-zinc-300"
              >
                <input
                  type="checkbox"
                  checked={sourcePriority.includes(src)}
                  onChange={() => toggleSource(src)}
                  className="h-3.5 w-3.5"
                />
                {src}
              </label>
            ))}
          </div>
          {sourcePriority.length > 0 && (
            <ol className="space-y-1">
              {sourcePriority.map((src, i) => (
                <li key={src} className="flex items-center gap-2 text-xs">
                  <span className="w-4 text-zinc-400">{i + 1}.</span>
                  <span className="font-mono text-zinc-700 dark:text-zinc-300">{src}</span>
                  <button
                    type="button"
                    onClick={() => moveSource(i, -1)}
                    disabled={i === 0}
                    className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 disabled:opacity-30"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSource(i, 1)}
                    disabled={i === sourcePriority.length - 1}
                    className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 disabled:opacity-30"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {strategy === 'manual_pin' && (
        <div className="mb-2">
          <label className="text-xs text-zinc-500 mb-1 block">Pinned value</label>
          <input
            value={pinnedValue}
            onChange={(e) => setPinnedValue(e.target.value)}
            placeholder="exact value to always use"
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-sm"
          />
        </div>
      )}

      <button
        type="button"
        disabled={setRule.isPending}
        onClick={() =>
          setRule.mutate(
            {
              kind,
              field,
              input: {
                strategy,
                source_priority: strategy === 'source_priority' ? sourcePriority : undefined,
                pinned_value: strategy === 'manual_pin' ? pinnedValue : undefined,
              },
            },
            {
              onSuccess: () => {
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
              },
            },
          )
        }
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 hover:bg-primary-700 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-60"
      >
        {setRule.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        {saved ? 'Saved' : 'Save rule'}
      </button>
      {setRule.isError && (
        <p className="text-xs text-red-600 dark:text-red-400 mt-1">
          {setRule.error instanceof Error ? setRule.error.message : 'Could not save this rule.'}
        </p>
      )}
    </div>
  );
}

function KindSection({ kind }: { kind: 'person' | 'company' }) {
  const rules = useSurvivorshipRules();
  const [customFields, setCustomFields] = useState<string[]>([]);
  const [newField, setNewField] = useState('');

  const rulesByField = new Map(
    (rules.data?.data ?? []).filter((r) => r.kind === kind).map((r) => [r.field, r]),
  );
  const fields = [...DEFAULT_FIELDS[kind], ...customFields];

  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <RuleEditor key={field} kind={kind} field={field} existing={rulesByField.get(field) ?? null} />
      ))}

      <div className="flex items-end gap-2 pt-1">
        <div className="flex flex-col">
          <label className="text-xs text-zinc-500 mb-1">Add a custom field</label>
          <input
            value={newField}
            onChange={(e) => setNewField(e.target.value)}
            placeholder="attributes.title"
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 px-2 py-1.5 text-sm w-56"
          />
        </div>
        <button
          type="button"
          disabled={!newField.trim() || fields.includes(newField.trim())}
          onClick={() => {
            setCustomFields((prev) => [...prev, newField.trim()]);
            setNewField('');
          }}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 px-3 py-1.5 text-sm font-medium disabled:opacity-60"
        >
          <Plus className="h-4 w-4" /> Add field
        </button>
      </div>
    </div>
  );
}

export function SurvivorshipRulesPage() {
  const [tab, setTab] = useState<'person' | 'company'>('person');

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
          <SlidersHorizontal className="h-6 w-6 text-primary-500" />
          Survivorship rules
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Per-field rules decide which linked source wins when a golden profile's attributes disagree.
        </p>
      </div>

      <div className="flex items-center gap-1 mb-4 border-b border-zinc-200 dark:border-zinc-800">
        {(['person', 'company'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === k
                ? 'border-primary-600 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            {k === 'person' ? 'Person' : 'Company'}
          </button>
        ))}
      </div>

      <KindSection kind={tab} />
    </div>
  );
}
