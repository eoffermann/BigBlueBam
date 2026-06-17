import { useState, useEffect, useRef } from 'react';
import { Play } from 'lucide-react';
import { useDataSources } from '@/hooks/use-data-sources';
import { api } from '@/lib/api';

interface ExplorerPageProps {
  onNavigate: (path: string) => void;
}

/**
 * The query_config a saved query persists (and that we run here). Falls back to
 * a sensible auto-generated config when a source is picked manually.
 */
type QueryConfig = Record<string, unknown>;

export function ExplorerPage({ onNavigate: _onNavigate }: ExplorerPageProps) {
  const { data: sourcesData } = useDataSources();
  const sources = sourcesData?.data ?? [];

  const [selectedSource, setSelectedSource] = useState('');
  const [results, setResults] = useState<Record<string, unknown>[] | null>(null);
  const [sqlText, setSqlText] = useState('');
  const [duration, setDuration] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the page is opened from a saved query (?saved_query_id=...), this
  // holds the loaded config so Run executes the saved definition rather than
  // the default first-measure guess.
  const [savedConfig, setSavedConfig] = useState<QueryConfig | null>(null);
  const [savedQueryName, setSavedQueryName] = useState<string | null>(null);
  const loadedQueryRef = useRef<string | null>(null);

  const currentSource = sources.find(
    (s) => `${s.product}:${s.entity}` === selectedSource,
  );

  /** Build the config to run: the loaded saved config if present, else a default. */
  const buildConfig = (source: NonNullable<typeof currentSource>): QueryConfig => {
    if (savedConfig) return savedConfig;
    return {
      measures: source.measures.slice(0, 1).map((m) => ({
        field: m.field,
        agg: m.aggregations[0],
      })),
      dimensions: source.dimensions.slice(0, 2).map((d) => ({
        field: d.field,
      })),
      limit: 50,
    };
  };

  const runConfig = async (source: NonNullable<typeof currentSource>, config: QueryConfig) => {
    setIsRunning(true);
    setError(null);
    try {
      const res = await api.post<{ data: { rows: Record<string, unknown>[]; sql: string; duration_ms: number } }>('/v1/query/preview', {
        data_source: source.product,
        entity: source.entity,
        query_config: config,
      });
      setResults(res.data.rows);
      setSqlText(res.data.sql);
      setDuration(res.data.duration_ms);
    } catch (err: any) {
      setError(err.message ?? 'Query failed');
      setResults(null);
    } finally {
      setIsRunning(false);
    }
  };

  const handleRun = async () => {
    if (!currentSource) return;
    await runConfig(currentSource, buildConfig(currentSource));
  };

  // On mount (or when sources load), honor a ?saved_query_id= handoff from the
  // Saved Queries page: fetch the saved query, select its source, load its
  // config, and auto-run it so the user lands on the result they saved.
  useEffect(() => {
    if (sources.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const savedQueryId = params.get('saved_query_id');
    const sourceParam = params.get('source');

    // Manual source preselect (no saved query) — e.g. ?source=bond:deals
    if (!savedQueryId && sourceParam && !selectedSource) {
      if (sources.some((s) => `${s.product}:${s.entity}` === sourceParam)) {
        setSelectedSource(sourceParam);
      }
      return;
    }

    if (!savedQueryId || loadedQueryRef.current === savedQueryId) return;
    loadedQueryRef.current = savedQueryId;

    (async () => {
      try {
        const res = await api.get<{ data: { data_source: string; entity: string; name: string; query_config: QueryConfig } }>(
          `/v1/saved-queries/${savedQueryId}`,
        );
        const sq = res.data;
        const sourceKey = `${sq.data_source}:${sq.entity}`;
        const source = sources.find((s) => `${s.product}:${s.entity}` === sourceKey);
        setSelectedSource(sourceKey);
        setSavedConfig(sq.query_config);
        setSavedQueryName(sq.name);
        if (source && sq.query_config && Object.keys(sq.query_config).length > 0) {
          await runConfig(source, sq.query_config);
        }
      } catch (err: any) {
        setError(err.message ?? 'Failed to load saved query');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Ad-Hoc Explorer</h1>
          <p className="text-sm text-zinc-500 mt-1">Query any data source interactively.</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left panel: source selection */}
        <div className="col-span-1 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Data Source</h3>
          {savedQueryName && (
            <div className="text-xs text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-950/20 rounded-lg px-3 py-1.5">
              Loaded saved query: <span className="font-medium">{savedQueryName}</span>
            </div>
          )}
          <select
            value={selectedSource}
            onChange={(e) => {
              setSelectedSource(e.target.value);
              // Manually changing the source abandons the loaded saved config.
              setSavedConfig(null);
              setSavedQueryName(null);
            }}
            className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-sm"
          >
            <option value="">Select a data source...</option>
            {sources.map((s) => (
              <option key={`${s.product}:${s.entity}`} value={`${s.product}:${s.entity}`}>
                [{s.product}] {s.label}
              </option>
            ))}
          </select>

          {currentSource && (
            <div className="space-y-2">
              <div>
                <h4 className="text-xs font-semibold text-zinc-500 uppercase mb-1">Measures</h4>
                {currentSource.measures.map((m) => (
                  <div key={m.field} className="text-xs text-zinc-600 dark:text-zinc-400 py-0.5">
                    {m.label} <span className="text-zinc-400">({m.aggregations.join(', ')})</span>
                  </div>
                ))}
              </div>
              <div>
                <h4 className="text-xs font-semibold text-zinc-500 uppercase mb-1">Dimensions</h4>
                {currentSource.dimensions.map((d) => (
                  <div key={d.field} className="text-xs text-zinc-600 dark:text-zinc-400 py-0.5">
                    {d.label} <span className="text-zinc-400">({d.type})</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={handleRun}
            disabled={!selectedSource || isRunning}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors text-sm font-medium disabled:opacity-50"
          >
            <Play className="h-4 w-4" />
            {isRunning ? 'Running...' : 'Run Query'}
          </button>
        </div>

        {/* Right panel: results */}
        <div className="col-span-2">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {sqlText && (
            <div className="mb-4 p-3 rounded-lg bg-zinc-50 dark:bg-zinc-800 text-xs font-mono text-zinc-600 dark:text-zinc-400 overflow-x-auto">
              {sqlText}
            </div>
          )}

          {duration != null && (
            <div className="mb-3 text-xs text-zinc-400">
              {results?.length ?? 0} rows in {duration}ms
            </div>
          )}

          {results && results.length > 0 ? (
            <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-50 dark:bg-zinc-800">
                    {Object.keys(results[0]!).map((key) => (
                      <th key={key} className="px-3 py-2 text-left text-xs font-semibold text-zinc-600 dark:text-zinc-400">
                        {key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((row, i) => (
                    <tr key={i} className="border-t border-zinc-100 dark:border-zinc-700/50">
                      {Object.values(row).map((val, j) => (
                        <td key={j} className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">
                          {val == null ? <span className="text-zinc-300 dark:text-zinc-600 italic">null</span> : String(val)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : results && results.length === 0 ? (
            <div className="text-center py-8 text-zinc-500 text-sm">No results</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
