import { useState, useRef, useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Upload,
  FileText,
  Globe,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  AlertCircle,
  Loader2,
  SlidersHorizontal,
  Download,
} from 'lucide-react';
import { Dialog } from '@/components/common/dialog';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Select } from '@/components/common/select';
import { api } from '@/lib/api';
import { parseCsvFile, distinctColumnValues, type CsvRow } from './csv-parse';
import {
  ValueMapEditor,
  serializeValueMap,
  seedPriorityGuesses,
  seedPhaseGuesses,
  type ValueChoice,
} from './value-map-editor';
import {
  LinksMappingPanel,
  serializeLinkMappings,
  type LinkMappingConfig,
} from './links-mapping-panel';
import { ImportConfirmStep, type ImportPreviewReport } from './import-confirm-step';
import {
  CustomFieldMappingPanel,
  type CustomFieldState,
} from './custom-field-mapping-panel';
import {
  inferCustomFieldType,
  serializeCustomFieldMappings,
  type CustomFieldConfig,
  type CustomFieldMappingWire,
  type CustomFieldType,
} from './custom-field-infer';
import {
  downloadErrorReport,
  parseImportErrors,
  type ErrorReportEntry,
} from './error-report';

type ImportSource = 'jira-csv' | 'trello-json' | 'generic-csv' | 'github-issues';

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

// mapping: CSV header -> target field. Special target SKIP / LINKS handled below.
type ColumnMapping = Record<string, string>;

const SKIP = '__skip__';
const LINKS = '__links__';
// Sentinel target for "Create a new custom field from this column" — the panel
// then captures field name / type / create_if_missing. Existing custom fields
// are offered as `cf:<field name>` targets (see customFieldTargets below).
const NEW_CUSTOM_FIELD = '__new_custom_field__';
const CUSTOM_FIELD_PREFIX = 'cf:';

// Rows are POSTed in fixed batches so massive sheets don't hit the 5000-row
// per-request cap (plan §5.4.7 / G6). The server's find-or-create paths are
// idempotent so chunks compose without duplication.
const CHUNK_SIZE = 1000;

const SOURCES: { value: ImportSource; label: string; description: string; icon: typeof FileText }[] = [
  { value: 'jira-csv', label: 'Jira CSV', description: 'Export from Jira as CSV', icon: FileText },
  { value: 'trello-json', label: 'Trello JSON', description: 'Export from Trello as JSON', icon: FileText },
  { value: 'generic-csv', label: 'Generic CSV', description: 'Any CSV with task data', icon: FileText },
  { value: 'github-issues', label: 'GitHub Issues', description: 'Import from a GitHub repo', icon: Globe },
];

// Target field list for the generic CSV mapping dropdowns. Values are the
// canonical API mapping keys (phase_name, assignee_email, …) plus the two
// frontend-only sentinels (SKIP, LINKS).
const TARGET_FIELDS = [
  { value: SKIP, label: 'Skip (default for unrecognized)' },
  { value: 'title', label: 'Title' },
  { value: 'description', label: 'Description' },
  { value: 'phase_name', label: 'Phase / Status' },
  { value: 'assignee_email', label: 'Assignee (email)' },
  { value: 'labels', label: 'Labels' },
  { value: 'priority', label: 'Priority' },
  { value: 'story_points', label: 'Story Points' },
  { value: 'due_date', label: 'Due Date' },
  { value: LINKS, label: 'Links' },
  // Match key for the "Update existing" duplicate strategy: an exported
  // sheet carries a human_id column (e.g. FRND-123); mapping it lets a
  // re-import update the matching tasks instead of creating duplicates.
  { value: 'human_id', label: 'Existing task ID (for update)' },
];

// Fields that support a value map ("Map values…").
const VALUE_MAPPABLE = new Set(['priority', 'phase_name']);

interface ImportResult {
  imported: number;
  skipped: number;
  updated?: number;
  errors: string[];
  cell_warnings?: { row: number; column: string; value: string; reason: string }[];
}

// Wire body shared by /import/csv and /import/csv/preview.
interface ImportBody {
  rows: CsvRow[];
  mapping: ColumnMapping;
  value_maps?: Record<string, Record<string, string | null>>;
  link_mappings?: { column: string; label: string | null; fetch_title: boolean }[];
  custom_field_mapping?: CustomFieldMappingWire[];
  options?: { duplicate_strategy?: 'create' | 'skip' | 'update'; date_locale?: 'us' | 'iso' };
}

// An existing project custom-field definition (from GET /projects/:id/custom-fields).
interface CustomFieldDefinition {
  id: string;
  name: string;
  field_type: CustomFieldType;
}

// Fuzzy auto-suggest a target field for a header. firstNonEmpty marks the
// leftmost column that has any data — it defaults to title.
function suggestTarget(header: string, isFirstNonEmpty: boolean): string {
  const lower = header.toLowerCase().trim();
  if (lower.includes('url') || lower.includes('link') || lower.includes('doc')) return LINKS;
  if (lower.includes('title') || lower === 'name' || lower === 'summary' || lower === 'feature')
    return 'title';
  if (lower.includes('description') || lower === 'body' || lower === 'notes') return 'description';
  if (lower.includes('priority') || lower === 'prio') return 'priority';
  if (lower.includes('assignee') || lower === 'owner' || lower === 'assigned to') return 'assignee_email';
  if (lower.includes('status') || lower === 'state' || lower === 'phase') return 'phase_name';
  if (lower.includes('due') || lower.includes('deadline')) return 'due_date';
  if (lower.includes('point') || lower === 'estimate') return 'story_points';
  if (lower.includes('label') || lower === 'tag' || lower === 'tags') return 'labels';
  if (isFirstNonEmpty) return 'title';
  return SKIP;
}

// Rebase a "Row N: …" error message by adding a chunk offset, so accumulated
// errors across chunks carry the global row number. Messages without a "Row N"
// prefix pass through unchanged.
function rebaseRowMessage(message: string, offset: number): string {
  if (offset === 0) return message;
  return message.replace(/^Row (\d+)\b/, (_m, n) => `Row ${Number(n) + offset}`);
}

export function ImportDialog({ open, onOpenChange, projectId }: ImportDialogProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [source, setSource] = useState<ImportSource | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [githubUrl, setGithubUrl] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<CsvRow[]>([]);
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({});
  const [trelloData, setTrelloData] = useState<unknown>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Value-map state, keyed by target field -> incoming value -> choice.
  const [valueMaps, setValueMaps] = useState<Record<string, Record<string, ValueChoice>>>({});
  // Which column the "Map values…" editor is currently expanded for (header).
  const [valueMapColumn, setValueMapColumn] = useState<string | null>(null);
  // Per-Links-column config.
  const [linkConfigs, setLinkConfigs] = useState<Record<string, LinkMappingConfig>>({});
  // Duplicate handling.
  const [duplicateStrategy, setDuplicateStrategy] = useState<'create' | 'skip' | 'update'>(
    'create',
  );
  // Date-locale toggle (due_date + date custom fields).
  const [dateLocale, setDateLocale] = useState<'us' | 'iso'>('iso');
  // Per-custom-field-column config (keyed by CSV header).
  const [customFieldConfigs, setCustomFieldConfigs] = useState<Record<string, CustomFieldState>>({});
  // Preview report for the confirm step.
  const [previewReport, setPreviewReport] = useState<ImportPreviewReport | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Chunked-submission progress: rows POSTed so far / total.
  const [chunkProgress, setChunkProgress] = useState<{ done: number; total: number } | null>(null);

  // Existing project phases (targets for phase_name value maps).
  const phasesQuery = useQuery({
    queryKey: ['phases', projectId],
    queryFn: () => api.get<{ data: { id: string; name: string }[] }>(`/projects/${projectId}/phases`),
    enabled: open && source === 'generic-csv',
    staleTime: 60_000,
  });
  const phaseOptions = useMemo(
    () => (phasesQuery.data?.data ?? []).map((p) => ({ value: p.name, label: p.name })),
    [phasesQuery.data],
  );

  // Existing project custom-field definitions (targets for opt-in mapping).
  const customFieldsQuery = useQuery({
    queryKey: ['custom-fields', projectId],
    queryFn: () =>
      api.get<{ data: CustomFieldDefinition[] }>(`/projects/${projectId}/custom-fields`),
    enabled: open && source === 'generic-csv',
    staleTime: 60_000,
  });
  const existingCustomFields = useMemo(
    () => customFieldsQuery.data?.data ?? [],
    [customFieldsQuery.data],
  );
  // Dropdown options for existing custom fields, as `cf:<name>` targets.
  const customFieldTargets = useMemo(
    () =>
      existingCustomFields.map((f) => ({
        value: `${CUSTOM_FIELD_PREFIX}${f.name}`,
        label: `Custom: ${f.name}`,
      })),
    [existingCustomFields],
  );

  const resetState = () => {
    setStep(1);
    setSource(null);
    setFile(null);
    setGithubUrl('');
    setParseError(null);
    setCsvHeaders([]);
    setCsvRows([]);
    setColumnMapping({});
    setTrelloData(null);
    setImportResult(null);
    setDragOver(false);
    setValueMaps({});
    setValueMapColumn(null);
    setLinkConfigs({});
    setDuplicateStrategy('create');
    setDateLocale('iso');
    setCustomFieldConfigs({});
    setPreviewReport(null);
    setPreviewError(null);
    setChunkProgress(null);
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) resetState();
    onOpenChange(isOpen);
  };

  // Columns currently mapped to Links.
  const linkColumns = useMemo(
    () => csvHeaders.filter((h) => columnMapping[h] === LINKS),
    [csvHeaders, columnMapping],
  );

  // Full dropdown option list: built-ins + existing custom fields + "Create…".
  const targetOptions = useMemo(
    () => [
      ...TARGET_FIELDS,
      ...customFieldTargets,
      { value: NEW_CUSTOM_FIELD, label: 'Create custom field…' },
    ],
    [customFieldTargets],
  );

  // Columns currently mapped to a custom field (new or existing).
  const customFieldColumns = useMemo(
    () =>
      csvHeaders.filter((h) => {
        const t = columnMapping[h];
        return t === NEW_CUSTOM_FIELD || (t?.startsWith(CUSTOM_FIELD_PREFIX) ?? false);
      }),
    [csvHeaders, columnMapping],
  );

  // Columns mapped to a NEW custom field (need a name/type panel).
  const newCustomFieldColumns = useMemo(
    () => csvHeaders.filter((h) => columnMapping[h] === NEW_CUSTOM_FIELD),
    [csvHeaders, columnMapping],
  );

  // Inferred type per new-custom-field column (sampled up to 200 cells).
  const inferredTypes = useMemo(() => {
    const out: Record<string, CustomFieldType> = {};
    for (const h of newCustomFieldColumns) out[h] = inferCustomFieldType(csvRows, h);
    return out;
  }, [newCustomFieldColumns, csvRows]);

  // Assemble the shared wire body from current state. `rowsOverride` lets the
  // chunked submitter pass a slice while reusing all the mapping serialization.
  const buildBody = useCallback(
    (rowsOverride?: CsvRow[]): ImportBody => {
      // mapping: only emit canonical built-in target keys. SKIP/LINKS and the
      // custom-field sentinels (NEW_CUSTOM_FIELD, cf:*) are NOT built-in fields —
      // links go to link_mappings, custom fields to custom_field_mapping.
      const mapping: ColumnMapping = {};
      for (const [header, target] of Object.entries(columnMapping)) {
        if (target === SKIP || target === LINKS) continue;
        if (target === NEW_CUSTOM_FIELD || target.startsWith(CUSTOM_FIELD_PREFIX)) continue;
        // first column wins for a given target (e.g. one title)
        if (!mapping[target]) mapping[target] = header;
      }

      // value_maps: keyed by target field. Find the header mapped to each
      // value-mappable target and serialize its selections.
      const value_maps: Record<string, Record<string, string | null>> = {};
      for (const target of VALUE_MAPPABLE) {
        const header = mapping[target];
        if (!header) continue;
        const selections = valueMaps[header];
        if (!selections) continue;
        const serialized = serializeValueMap(selections);
        if (Object.keys(serialized).length > 0) value_maps[target] = serialized;
      }

      // custom_field_mapping: one entry per custom-field-mapped column.
      const cfConfigs: CustomFieldConfig[] = customFieldColumns.map((header) => {
        const target = columnMapping[header] ?? '';
        const existingName = target.startsWith(CUSTOM_FIELD_PREFIX)
          ? target.slice(CUSTOM_FIELD_PREFIX.length)
          : '';
        const state = customFieldConfigs[header];
        if (existingName) {
          // Mapping to an existing field: write to it, never create.
          const def = existingCustomFields.find((f) => f.name === existingName);
          return {
            column: header,
            field_name: existingName,
            field_type: def?.field_type ?? state?.field_type ?? 'text',
            create_if_missing: false,
          };
        }
        // New custom field: name defaults to the header; type is the (possibly
        // overridden) inferred type; create_if_missing is always true.
        return {
          column: header,
          field_name: (state?.field_name ?? header).trim() || header,
          field_type: state?.field_type ?? inferCustomFieldType(csvRows, header),
          create_if_missing: true,
        };
      });

      const body: ImportBody = {
        rows: rowsOverride ?? csvRows,
        mapping,
        options: { duplicate_strategy: duplicateStrategy, date_locale: dateLocale },
      };
      if (Object.keys(value_maps).length > 0) body.value_maps = value_maps;
      if (linkColumns.length > 0) {
        body.link_mappings = serializeLinkMappings(linkColumns, linkConfigs);
      }
      const cfWire = serializeCustomFieldMappings(cfConfigs);
      if (cfWire.length > 0) body.custom_field_mapping = cfWire;
      return body;
    },
    [
      columnMapping,
      valueMaps,
      csvRows,
      duplicateStrategy,
      dateLocale,
      linkColumns,
      linkConfigs,
      customFieldColumns,
      customFieldConfigs,
      existingCustomFields,
    ],
  );

  const previewMutation = useMutation({
    mutationFn: (body: ImportBody) =>
      api.post<{ data: ImportPreviewReport }>(
        `/projects/${projectId}/import/csv/preview`,
        body,
      ),
    onSuccess: (res) => {
      setPreviewReport(res.data);
      setPreviewError(null);
    },
    onError: (err) => {
      setPreviewError(err instanceof Error ? err.message : 'Preview failed');
      setPreviewReport(null);
    },
  });

  // Chunked CSV submission (plan §5.4.7 / G6): POST the full row set in fixed
  // batches, accumulating { imported, skipped, updated, errors, cell_warnings }
  // and reporting progress. The error row numbers are rebased to the global row
  // index so a downloadable report stays accurate across chunks.
  const importCsv = useMutation({
    mutationFn: async (): Promise<ImportResult> => {
      const total = csvRows.length;
      const acc: Required<Pick<ImportResult, 'imported' | 'skipped' | 'updated' | 'errors'>> & {
        cell_warnings: NonNullable<ImportResult['cell_warnings']>;
      } = { imported: 0, skipped: 0, updated: 0, errors: [], cell_warnings: [] };

      setChunkProgress({ done: 0, total });
      for (let offset = 0; offset < total; offset += CHUNK_SIZE) {
        const slice = csvRows.slice(offset, offset + CHUNK_SIZE);
        const body = buildBody(slice);
        const res = await api.post<{ data: ImportResult }>(
          `/projects/${projectId}/import/csv`,
          body,
        );
        const d = res.data;
        acc.imported += d.imported;
        acc.skipped += d.skipped;
        acc.updated += d.updated ?? 0;
        // Rebase "Row N" prefixes to the global index for accurate reporting.
        for (const e of d.errors) {
          acc.errors.push(rebaseRowMessage(e, offset));
        }
        for (const w of d.cell_warnings ?? []) {
          acc.cell_warnings.push({ ...w, row: w.row + offset });
        }
        setChunkProgress({ done: Math.min(offset + slice.length, total), total });
      }
      return acc;
    },
    onSuccess: (data) => {
      setImportResult(data);
      setChunkProgress(null);
      setStep(5);
      queryClient.invalidateQueries({ queryKey: ['board', projectId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
    onError: () => {
      setChunkProgress(null);
    },
  });

  const importTrello = useMutation({
    mutationFn: (data: unknown) =>
      api.post<{ data: ImportResult }>(`/projects/${projectId}/import/trello`, data),
    onSuccess: (res) => {
      setImportResult(res.data);
      setStep(5);
      queryClient.invalidateQueries({ queryKey: ['board', projectId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });

  const importGithub = useMutation({
    mutationFn: (url: string) =>
      api.post<{ data: ImportResult }>(`/projects/${projectId}/import/github`, { url }),
    onSuccess: (res) => {
      setImportResult(res.data);
      setStep(5);
      queryClient.invalidateQueries({ queryKey: ['board', projectId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });

  const isImporting = importCsv.isPending || importTrello.isPending || importGithub.isPending;

  const handleFileSelect = useCallback(
    async (selectedFile: File) => {
      setFile(selectedFile);
      setParseError(null);

      if (source === 'trello-json') {
        try {
          const text = await selectedFile.text();
          const json = JSON.parse(text);
          setTrelloData(json);
          setStep(3);
        } catch {
          setParseError('Invalid JSON file.');
        }
        return;
      }

      // CSV sources (jira-csv + generic-csv) parse with papaparse.
      try {
        const { headers, rows } = await parseCsvFile(selectedFile);
        setCsvHeaders(headers);
        setCsvRows(rows);

        if (source === 'jira-csv') {
          // Jira keeps its own simpler mapping (canonical keys).
          const jira: Record<string, string> = {
            Summary: 'title',
            Description: 'description',
            Priority: 'priority',
            Assignee: 'assignee_email',
            Status: 'phase_name',
            'Due Date': 'due_date',
            'Story Points': 'story_points',
            Labels: 'labels',
          };
          const mapping: ColumnMapping = {};
          for (const h of headers) {
            const target = jira[h];
            if (target) mapping[h] = target;
          }
          setColumnMapping(mapping);
        } else {
          // Generic: fuzzy auto-suggest. firstNonEmpty = leftmost column with data.
          const firstNonEmptyIdx = headers.findIndex((h) =>
            rows.some((r) => (r[h] ?? '').trim() !== ''),
          );
          const mapping: ColumnMapping = {};
          for (let idx = 0; idx < headers.length; idx++) {
            const h = headers[idx] ?? '';
            mapping[h] = suggestTarget(h, idx === firstNonEmptyIdx);
          }
          setColumnMapping(mapping);
        }

        setStep(3);
      } catch (err) {
        setParseError(err instanceof Error ? err.message : 'Could not parse CSV.');
      }
    },
    [source],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile) handleFileSelect(droppedFile);
    },
    [handleFileSelect],
  );

  // When a column's target changes, seed value-map guesses if it became a
  // value-mappable target and we have no selections yet.
  const handleMappingChange = (header: string, target: string) => {
    setColumnMapping((prev) => ({ ...prev, [header]: target }));
    if (valueMapColumn === header && !VALUE_MAPPABLE.has(target)) {
      setValueMapColumn(null);
    }
    if (VALUE_MAPPABLE.has(target) && !valueMaps[header]) {
      const distinct = distinctColumnValues(csvRows, header);
      const seeded =
        target === 'priority'
          ? seedPriorityGuesses(distinct)
          : seedPhaseGuesses(distinct, phaseOptions);
      setValueMaps((prev) => ({ ...prev, [header]: seeded }));
    }
    // Seed a custom-field config (name = header, type = inferred) when a column
    // becomes a NEW custom field and we have no config yet.
    if (target === NEW_CUSTOM_FIELD && !customFieldConfigs[header]) {
      setCustomFieldConfigs((prev) => ({
        ...prev,
        [header]: { field_name: header, field_type: inferCustomFieldType(csvRows, header) },
      }));
    }
  };

  // Preview is read-only but still bound by the 5000-row request cap, so for a
  // larger sheet we preview the first 5000 rows and surface a sample note on the
  // confirm screen. The actual import always runs the full set (chunked).
  const PREVIEW_CAP = 5000;
  const previewIsSampled = csvRows.length > PREVIEW_CAP;
  const handleProceedToConfirm = () => {
    setStep(4);
    const sample = previewIsSampled ? csvRows.slice(0, PREVIEW_CAP) : csvRows;
    previewMutation.mutate(buildBody(sample));
  };

  const handleImport = () => {
    if (source === 'trello-json' && trelloData) {
      importTrello.mutate(trelloData);
    } else if (source === 'github-issues') {
      importGithub.mutate(githubUrl);
    } else {
      importCsv.mutate();
    }
  };

  // Build + download a CSV report of failed/warned rows from the commit result.
  const handleDownloadErrorReport = () => {
    if (!importResult) return;
    const entries: ErrorReportEntry[] = [
      ...parseImportErrors(importResult.errors),
      ...(importResult.cell_warnings ?? []).map((w) => ({
        row: w.row,
        reason: `${w.column}: ${w.reason} ("${w.value}")`,
      })),
    ];
    // Attach the original row cells where the row number is in range (1-based).
    for (const e of entries) {
      const original = e.row > 0 ? csvRows[e.row - 1] : undefined;
      if (original) e.data = original;
    }
    downloadErrorReport(entries, csvHeaders);
  };

  const hasTitle = Object.values(columnMapping).some((t) => t === 'title');
  const previewRows = csvRows.slice(0, 5);
  const isGeneric = source === 'generic-csv';
  const totalSteps = isGeneric ? 5 : 4;
  // Non-generic flows jump straight to the results screen (step 5); show it as
  // the final step in the indicator rather than "Step 5 of 4".
  const displayStep = !isGeneric && step === 5 ? totalSteps : step;

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Import Tasks"
      description={`Step ${displayStep} of ${totalSteps}`}
      className="max-w-2xl"
    >
      <div className="min-h-[300px]">
        {/* Step 1: Choose Source */}
        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-500 mb-4">Choose your import source:</p>
            {SOURCES.map((s) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.value}
                  onClick={() => {
                    setSource(s.value);
                    setStep(2);
                  }}
                  className={`w-full flex items-center gap-4 p-4 rounded-lg border transition-colors text-left ${
                    source === s.value
                      ? 'border-primary-500 bg-primary-50 dark:bg-zinc-800'
                      : 'border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
                  }`}
                >
                  <div className="h-10 w-10 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center shrink-0">
                    <Icon className="h-5 w-5 text-zinc-600 dark:text-zinc-400" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{s.label}</p>
                    <p className="text-xs text-zinc-500">{s.description}</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-zinc-400 ml-auto" />
                </button>
              );
            })}
          </div>
        )}

        {/* Step 2: Upload File or Paste URL */}
        {step === 2 && (
          <div className="space-y-4">
            {source === 'github-issues' ? (
              <div className="space-y-4">
                <p className="text-sm text-zinc-500">
                  Paste the GitHub repository URL to import issues from:
                </p>
                <Input
                  id="github-url"
                  label="Repository URL"
                  placeholder="https://github.com/owner/repo"
                  value={githubUrl}
                  onChange={(e) => setGithubUrl(e.target.value)}
                />
                <div className="flex justify-between pt-2">
                  <Button variant="secondary" onClick={() => setStep(1)}>
                    <ChevronLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <Button disabled={!githubUrl.trim()} onClick={() => setStep(3)}>
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-zinc-500">
                  Upload your {source === 'trello-json' ? 'Trello JSON export' : 'CSV'} file:
                </p>

                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`flex flex-col items-center justify-center h-40 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
                    dragOver
                      ? 'border-primary-500 bg-primary-50 dark:bg-zinc-800'
                      : 'border-zinc-300 dark:border-zinc-600 hover:border-zinc-400'
                  }`}
                >
                  <Upload className="h-8 w-8 text-zinc-400 mb-2" />
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    {file ? file.name : 'Drag & drop or click to upload'}
                  </p>
                  <p className="text-xs text-zinc-400 mt-1">
                    {source === 'trello-json' ? '.json' : '.csv'} files accepted
                  </p>
                </div>

                {parseError && (
                  <p className="text-sm text-red-600 flex items-center gap-1.5">
                    <AlertCircle className="h-4 w-4" />
                    {parseError}
                  </p>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept={source === 'trello-json' ? '.json' : '.csv'}
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFileSelect(f);
                  }}
                />

                <div className="flex justify-between pt-2">
                  <Button variant="secondary" onClick={() => setStep(1)}>
                    <ChevronLeft className="h-4 w-4" />
                    Back
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Preview & Mapping */}
        {step === 3 && (
          <div className="space-y-4">
            {source === 'github-issues' ? (
              <div className="space-y-4">
                <p className="text-sm text-zinc-500">
                  Ready to import issues from:{' '}
                  <span className="font-mono text-zinc-700 dark:text-zinc-300">{githubUrl}</span>
                </p>
                <p className="text-sm text-zinc-500">
                  Issues will be imported as tasks with their title, description, labels, and assignees.
                </p>
                <div className="flex justify-between pt-2">
                  <Button variant="secondary" onClick={() => setStep(2)}>
                    <ChevronLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={handleImport} loading={isImporting}>
                    Import Issues
                  </Button>
                </div>
              </div>
            ) : source === 'trello-json' ? (
              <div className="space-y-4">
                <p className="text-sm text-zinc-500">
                  Trello board data loaded from <span className="font-mono">{file?.name}</span>. Cards
                  will be imported as tasks, with lists mapped to phases.
                </p>
                <div className="flex justify-between pt-2">
                  <Button variant="secondary" onClick={() => setStep(2)}>
                    <ChevronLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={handleImport} loading={isImporting}>
                    Import from Trello
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-zinc-500">
                  Map columns to task fields. Unmapped columns are ignored.
                </p>

                {/* Column mapping */}
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {csvHeaders.map((header) => {
                    const target = columnMapping[header] ?? SKIP;
                    const canMapValues = VALUE_MAPPABLE.has(target);
                    return (
                      <div key={header} className="space-y-1.5">
                        <div className="flex items-center gap-3">
                          <span
                            className="text-sm text-zinc-700 dark:text-zinc-300 w-40 truncate shrink-0"
                            title={header}
                          >
                            {header}
                          </span>
                          <ChevronRight className="h-4 w-4 text-zinc-400 shrink-0" />
                          <Select
                            options={targetOptions}
                            value={target}
                            onValueChange={(val) => handleMappingChange(header, val)}
                            className="flex-1"
                          />
                          {canMapValues && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setValueMapColumn(valueMapColumn === header ? null : header)
                              }
                            >
                              <SlidersHorizontal className="h-3.5 w-3.5" />
                              Map values
                            </Button>
                          )}
                        </div>
                        {canMapValues && valueMapColumn === header && (
                          <div className="pl-[11.5rem] pr-1">
                            <ValueMapEditor
                              field={target as 'priority' | 'phase_name'}
                              distinctValues={distinctColumnValues(csvRows, header)}
                              selections={valueMaps[header] ?? {}}
                              onChange={(sel) =>
                                setValueMaps((prev) => ({ ...prev, [header]: sel }))
                              }
                              bamValues={target === 'phase_name' ? phaseOptions : undefined}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Links panel */}
                {linkColumns.length > 0 && (
                  <div className="border-t border-zinc-200 dark:border-zinc-700 pt-3">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-2">Links</p>
                    <LinksMappingPanel
                      columns={linkColumns}
                      configs={linkConfigs}
                      onChange={setLinkConfigs}
                    />
                  </div>
                )}

                {/* New custom fields panel */}
                {newCustomFieldColumns.length > 0 && (
                  <div className="border-t border-zinc-200 dark:border-zinc-700 pt-3">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                      New custom fields
                    </p>
                    <CustomFieldMappingPanel
                      columns={newCustomFieldColumns}
                      inferredTypes={inferredTypes}
                      configs={customFieldConfigs}
                      onChange={setCustomFieldConfigs}
                    />
                  </div>
                )}

                {/* Duplicate strategy + date locale */}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-zinc-200 dark:border-zinc-700 pt-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">On duplicate title:</span>
                    <Select
                      options={[
                        { value: 'create', label: 'Create anyway' },
                        { value: 'skip', label: 'Skip duplicates' },
                        { value: 'update', label: 'Update existing (match by ID or title)' },
                      ]}
                      value={duplicateStrategy}
                      onValueChange={(val) =>
                        setDuplicateStrategy(val as 'create' | 'skip' | 'update')
                      }
                      className="w-48"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-zinc-700 dark:text-zinc-300">Date format:</span>
                    <Select
                      options={[
                        { value: 'iso', label: 'ISO / DD-MM' },
                        { value: 'us', label: 'US (MM/DD)' },
                      ]}
                      value={dateLocale}
                      onValueChange={(val) => setDateLocale(val as 'us' | 'iso')}
                      className="w-40"
                    />
                  </div>
                </div>

                {/* Preview table */}
                {previewRows.length > 0 && (
                  <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-zinc-50 dark:bg-zinc-800">
                          {csvHeaders.slice(0, 5).map((h) => (
                            <th
                              key={h}
                              className="px-3 py-2 text-left font-medium text-zinc-500 border-b border-zinc-200 dark:border-zinc-700"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewRows.map((row, i) => (
                          <tr
                            key={i}
                            className="border-b border-zinc-100 dark:border-zinc-800 last:border-0"
                          >
                            {csvHeaders.slice(0, 5).map((h) => (
                              <td
                                key={h}
                                className="px-3 py-2 text-zinc-700 dark:text-zinc-300 truncate max-w-[150px]"
                              >
                                {row[h] ?? ''}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <p className="text-xs text-zinc-400">Total rows: {csvRows.length}</p>

                <div className="flex justify-between pt-2">
                  <Button variant="secondary" onClick={() => setStep(2)}>
                    <ChevronLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <Button onClick={handleProceedToConfirm} disabled={!hasTitle}>
                    Preview
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 4: Confirm (dry-run report) — generic CSV only */}
        {step === 4 && isGeneric && (
          <div className="space-y-4">
            {previewIsSampled && !previewMutation.isPending && (
              <p className="text-xs text-yellow-700 dark:text-yellow-400 flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" />
                Preview reflects the first {PREVIEW_CAP.toLocaleString()} of{' '}
                {csvRows.length.toLocaleString()} rows. The full set imports in batches.
              </p>
            )}
            <ImportConfirmStep
              report={previewReport}
              loading={previewMutation.isPending}
              error={previewError}
            />
            {chunkProgress && (
              <div className="space-y-1">
                <div className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                  <div
                    className="h-full bg-primary-500 transition-[width]"
                    style={{
                      width: `${chunkProgress.total > 0 ? Math.round((chunkProgress.done / chunkProgress.total) * 100) : 0}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-zinc-500 text-center">
                  Importing {chunkProgress.done.toLocaleString()} / {chunkProgress.total.toLocaleString()} rows…
                </p>
              </div>
            )}
            <div className="flex justify-between pt-2">
              <Button variant="secondary" onClick={() => setStep(3)} disabled={isImporting}>
                <ChevronLeft className="h-4 w-4" />
                Back
              </Button>
              <Button
                onClick={handleImport}
                loading={isImporting}
                disabled={previewMutation.isPending || !previewReport}
              >
                Import {csvRows.length.toLocaleString()} Rows
              </Button>
            </div>
          </div>
        )}

        {/* Step 5 (generic) / Step 4 (other): Results */}
        {step === 5 && (
          <div className="flex flex-col items-center justify-center py-8 space-y-4">
            {importResult && importResult.errors.length === 0 ? (
              <>
                <CheckCircle2 className="h-12 w-12 text-green-500" />
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                  Import Complete
                </h3>
                <p className="text-sm text-zinc-500">
                  Imported {importResult.imported} tasks
                  {importResult.skipped > 0 ? `, skipped ${importResult.skipped}.` : '.'}
                </p>
              </>
            ) : importResult ? (
              <>
                <AlertCircle className="h-12 w-12 text-yellow-500" />
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                  Import Completed with Issues
                </h3>
                <p className="text-sm text-zinc-500">
                  Imported {importResult.imported} tasks. {importResult.errors.length} rows had errors.
                </p>
                {importResult.errors.length > 0 && (
                  <ul className="text-xs text-zinc-500 max-h-32 overflow-y-auto list-disc pl-5 self-stretch">
                    {importResult.errors.slice(0, 50).map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
            )}

            <div className="flex items-center gap-3">
              {importResult && importResult.errors.length > 0 && (
                <Button variant="secondary" onClick={handleDownloadErrorReport}>
                  <Download className="h-4 w-4" />
                  Download error report
                </Button>
              )}
              <Button onClick={() => handleOpenChange(false)}>Close</Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
