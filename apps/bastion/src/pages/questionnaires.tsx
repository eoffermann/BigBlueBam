import { useState } from 'react';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import { useCan } from '@bigbluebam/ui/use-can';
import { getImpersonation, impersonateHeader } from '@bigbluebam/ui/impersonation-banner';
import type { AnswerLibraryRow, QuestionnaireItemRow, QuestionnaireRow, QuestionnaireSheetMap } from '@/lib/api';
import { binAssetIdFrom, NOT_A_BIN_LINK } from '@/lib/bin-link';
import { friendlyError } from '@/lib/errors';
import {
  useAnswerLibrary,
  useApproveQuestionnaire,
  useAutofill,
  useCreateQuestionnaire,
  useQuestionnaire,
  useQuestionnaireItems,
  useQuestionnaires,
  useReviewItem,
  useUpdateAnswerLibrary,
  useUpdateQuestionnaire,
} from '@/hooks/use-bastion';

// Questionnaires (spec 6.1, 2.7): add a customer's security questionnaire (a file from Bin or rows
// pasted from a spreadsheet), check which column holds the questions, let Bastion draft the
// answers from what it can prove, review them, Approve, and download the answered file. Plain
// language (spec 6.2): confidence is "Sure", "Check this" or "Needs an expert"; citations are
// named chips; no raw ids. Floored actions are hidden with useCan; Approve is disabled while
// impersonating, with the reason shown.

const btn = 'px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50';
const primary = `${btn} bg-primary-600 text-white hover:bg-primary-700`;
const secondary = `${btn} border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200`;
const input = 'mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm';

export const STATUS_WORDS: Record<QuestionnaireRow['status'], string> = {
  uploaded: 'Added',
  mapping: 'Check the columns',
  answering: 'Drafting answers',
  in_review: 'Ready for review',
  approved: 'Approved',
  exported: 'Approved and downloaded',
  failed: 'Could not be read',
};

const BAND_STYLE: Record<string, string> = {
  high: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  low: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

const IMPERSONATING_NOTE = 'You are viewing Bastion as another person. Only that person can approve these answers.';

/**
 * How long drafting takes, from the spec 7.3 throughput: one organization gets about 3 to 6 AI
 * answers a minute. Returns plain words, e.g. "about 16 to 32 minutes".
 */
export function draftingEstimate(rowsLeft: number): string {
  if (rowsLeft <= 0) return 'a moment';
  const lo = Math.max(1, Math.ceil(rowsLeft / 6));
  const hi = Math.max(lo, Math.ceil(rowsLeft / 3));
  return lo === hi ? `about ${lo} minute${lo === 1 ? '' : 's'}` : `about ${lo} to ${hi} minutes`;
}

const yesNoWords = (v: boolean | null) => (v === true ? 'Yes' : v === false ? 'No' : null);

function formatDate(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
}

/* ------------------------------ list ------------------------------ */

function AddQuestionnaireForm({ onCreated }: { onCreated: (id: string) => void }) {
  const create = useCreateQuestionnaire();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [requester, setRequester] = useState('');
  const [mode, setMode] = useState<'paste' | 'bin'>('paste');
  const [pasted, setPasted] = useState('');
  const [binLink, setBinLink] = useState('');
  const assetId = binAssetIdFrom(binLink);
  if (!open) {
    return (
      <button type="button" className={primary} onClick={() => setOpen(true)}>
        Add a questionnaire
      </button>
    );
  }
  const ready = title.trim().length > 0 && (mode === 'paste' ? pasted.trim().length > 0 : !!assetId);
  return (
    <form
      className="space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        create.mutate(
          {
            title: title.trim(),
            requester_label: requester.trim() || null,
            source: mode === 'paste' ? { kind: 'pasted', text: pasted, format: pasted.includes('\t') ? 'tsv' : 'csv' } : { kind: 'bin_asset', bin_asset_id: assetId as string },
          },
          { onSuccess: (r) => onCreated(r.data.id) },
        );
      }}
    >
      <label className="block text-sm">
        <span className="text-zinc-700 dark:text-zinc-300">Name</span>
        <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Howell Industries Vendor Security Review" />
      </label>
      <label className="block text-sm">
        <span className="text-zinc-700 dark:text-zinc-300">Who sent it (optional)</span>
        <input className={input} value={requester} onChange={(e) => setRequester(e.target.value)} />
      </label>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === 'paste'} onChange={() => setMode('paste')} /> Paste the rows
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={mode === 'bin'} onChange={() => setMode('bin')} /> A file in Bin (Excel or CSV)
        </label>
      </div>
      {mode === 'paste' ? (
        <label className="block text-sm">
          <span className="text-zinc-700 dark:text-zinc-300">Copy the questions from the spreadsheet (with the header row) and paste them here</span>
          <textarea className={`${input} h-40 font-mono`} value={pasted} onChange={(e) => setPasted(e.target.value)} />
        </label>
      ) : (
        <label className="block text-sm">
          <span className="text-zinc-700 dark:text-zinc-300">The file's link in Bin</span>
          <input className={input} value={binLink} onChange={(e) => setBinLink(e.target.value)} placeholder="Open the file in Bin and copy the address" />
          {binLink && !assetId && <span className="text-xs text-amber-700">{NOT_A_BIN_LINK}</span>}
        </label>
      )}
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={!ready || create.isPending}>
          Add it
        </button>
        <button type="button" className={secondary} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {create.error && <p className="text-xs text-red-600">{friendlyError(create.error)}</p>}
    </form>
  );
}

function AnswerLibrary() {
  const [q, setQ] = useState('');
  const lib = useAnswerLibrary(q);
  const canWrite = useCan('bastion.answer_library.write');
  const update = useUpdateAnswerLibrary();
  const rows: AnswerLibraryRow[] = lib.data?.data ?? [];
  return (
    <section className="space-y-3" data-testid="answer-library">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Answer library</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Answers you approved before. Bastion reuses them, and marks one to check again when a control it relies on changes.</p>
      <input className={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search approved answers" />
      {lib.isLoading && <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />}
      {!lib.isLoading && rows.length === 0 && <p className="text-sm text-zinc-500">No approved answers yet. They appear here after you approve a questionnaire.</p>}
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {rows.map((r) => (
          <li key={r.id} className="py-3 space-y-1">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.question_text}</p>
            <p className="text-sm text-zinc-700 dark:text-zinc-300">
              {yesNoWords(r.yes_no) && <strong>{yesNoWords(r.yes_no)}. </strong>}
              {r.answer_text}
            </p>
            <p className="text-xs text-zinc-500">
              {r.approved_by_name ? `Approved by ${r.approved_by_name}` : 'Approved'}
              {r.approved_at ? ` on ${formatDate(r.approved_at)}` : ''}
            </p>
            {r.stale && <p className="text-xs text-amber-700">{r.stale_words}</p>}
            {canWrite && (
              <div className="flex gap-2">
                {r.stale && (
                  <button type="button" className={secondary} disabled={update.isPending} onClick={() => update.mutate({ id: r.id, body: { stale: false } })}>
                    It still holds
                  </button>
                )}
                <button type="button" className={secondary} disabled={update.isPending} onClick={() => update.mutate({ id: r.id, body: { retired: true } })}>
                  Retire
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function QuestionnairesPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const q = useQuestionnaires();
  const canWrite = useCan('bastion.questionnaire.write');
  const canLibrary = useCan('bastion.answer_library.read');
  const rows = q.data?.data ?? [];
  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Questionnaires</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Security questionnaires from customers. Bastion drafts each answer from what it can prove, says how sure it is, and never claims what it cannot prove. A person approves before anything goes out.
          </p>
        </div>
        {canWrite && <AddQuestionnaireForm onCreated={(id) => onNavigate(`/questionnaires/${id}`)} />}
      </div>
      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />}
      {q.error && <p className="text-sm text-red-600">{friendlyError(q.error)}</p>}
      {!q.isLoading && rows.length === 0 && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="questionnaires-empty">
          No questionnaires yet. When a customer sends one, put the file in Bin (or copy its rows) and add it here.
        </p>
      )}
      {rows.length > 0 && (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800" data-testid="questionnaire-list">
          {rows.map((r) => (
            <li key={r.id}>
              <button type="button" className="w-full text-left py-3" onClick={() => onNavigate(`/questionnaires/${r.id}`)}>
                <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100">{r.title}</span>
                <span className="block text-xs text-zinc-600 dark:text-zinc-400">
                  {STATUS_WORDS[r.status]}
                  {r.requester_label ? ` · from ${r.requester_label}` : ''}
                  {r.row_count > 0 ? ` · ${r.row_count} questions` : ''}
                  {r.row_count > 0 && r.rows_done > 0 ? ` · ${r.high_count} Sure, ${r.medium_count} Check this, ${r.low_count} Needs an expert` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {canLibrary && <AnswerLibrary />}
    </div>
  );
}

/* ------------------------------ detail ------------------------------ */

function columnOptions(count: number) {
  return Array.from({ length: Math.max(count, 1) }, (_, i) => i);
}

function MappingStep({ q }: { q: QuestionnaireRow }) {
  const update = useUpdateQuestionnaire();
  const autofill = useAutofill();
  const canWrite = useCan('bastion.questionnaire.write');
  const current = q.column_map?.sheets[0];
  const sheet = q.sheet_preview?.find((s) => s.name === current?.sheet_name) ?? q.sheet_preview?.[0];
  const [map, setMap] = useState<QuestionnaireSheetMap | undefined>(current);
  if (!sheet || !map) return <p className="text-sm text-zinc-600">This questionnaire has no rows Bastion could read.</p>;
  const header = map.header_row !== null ? (sheet.rows[map.header_row] ?? []) : [];
  const colName = (i: number) => (header[i]?.trim() ? `${header[i]}` : `Column ${i + 1}`);
  const set = (patch: Partial<QuestionnaireSheetMap>) => setMap({ ...map, ...patch });
  const changed = JSON.stringify(map) !== JSON.stringify(current);
  return (
    <section className="space-y-3" data-testid="mapping-step">
      <h2 className="text-base font-semibold">Check the columns</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {q.column_map?.guessed ? 'Bastion guessed which column holds the questions. Check it against the first rows below.' : 'These are the columns you chose.'}
        {q.source_truncated ? ' The file was larger than Bastion reads at once, so the last rows or columns were left out.' : ''}
      </p>
      <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
        <table className="text-xs">
          <tbody>
            {sheet.rows.map((r, i) => (
              <tr key={`row-${i}-${r.join('|').slice(0, 40)}`} className={i === map.header_row ? 'font-semibold bg-zinc-50 dark:bg-zinc-900' : ''}>
                {r.map((c, j) => (
                  <td key={`c-${j}-${c.slice(0, 20)}`} className={`px-2 py-1 border-b border-zinc-100 dark:border-zinc-800 ${j === map.question_column ? 'bg-primary-50 dark:bg-primary-950/30' : ''}`}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canWrite && (
        <div className="grid gap-3 sm:grid-cols-3 text-sm">
          <label>
            Questions are in
            <select className={input} value={map.question_column} onChange={(e) => set({ question_column: Number(e.target.value) })}>
              {columnOptions(sheet.column_count).map((i) => (
                <option key={i} value={i}>
                  {colName(i)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Write answers into
            <select className={input} value={map.answer_column ?? ''} onChange={(e) => set({ answer_column: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">A new "Answer" column</option>
              {columnOptions(sheet.column_count).map((i) => (
                <option key={i} value={i}>
                  {colName(i)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Yes or No goes into
            <select className={input} value={map.yes_no_column ?? ''} onChange={(e) => set({ yes_no_column: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">A new "Yes/No" column</option>
              {columnOptions(sheet.column_count).map((i) => (
                <option key={i} value={i}>
                  {colName(i)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          {changed && (
            <button type="button" className={secondary} disabled={update.isPending} onClick={() => update.mutate({ id: q.id, body: { column_map: { sheets: [map] } } })}>
              Use these columns
            </button>
          )}
          <button type="button" className={primary} disabled={changed || autofill.isPending || q.row_count === 0} onClick={() => autofill.mutate({ id: q.id })}>
            Draft the answers
          </button>
          <span className="text-xs text-zinc-500">
            {q.row_count} questions; drafting takes {draftingEstimate(q.row_count)}.
          </span>
        </div>
      )}
      {(update.error || autofill.error) && <p className="text-xs text-red-600">{friendlyError(update.error ?? autofill.error)}</p>}
    </section>
  );
}

function ItemRow({ item, questionnaireId, locked }: { item: QuestionnaireItemRow; questionnaireId: string; locked: boolean }) {
  const review = useReviewItem(questionnaireId);
  const canWrite = useCan('bastion.questionnaire.write');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.final_answer ?? item.draft_answer ?? '');
  const [yesNo, setYesNo] = useState<string>(String(item.final_yes_no ?? item.draft_yes_no ?? ''));
  const shownAnswer = item.final_answer ?? item.draft_answer;
  const shownYesNo = yesNoWords(item.final_yes_no ?? item.draft_yes_no);
  return (
    <li className="py-4 space-y-2" data-testid="questionnaire-item" data-band={item.confidence_band ?? 'none'}>
      <div className="flex items-start justify-between gap-3">
        <div>
          {item.section && <p className="text-xs uppercase tracking-wide text-zinc-500">{item.section}</p>}
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.question_text}</p>
        </div>
        {item.confidence_words && (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${BAND_STYLE[item.confidence_band ?? 'low']}`} data-testid="band">
            {item.confidence_words}
          </span>
        )}
      </div>
      {!editing && (
        <p className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="answer">
          {shownYesNo && <strong>{shownYesNo}. </strong>}
          {shownAnswer ?? <span className="text-zinc-500">No draft. Someone who knows needs to answer this.</span>}
        </p>
      )}
      {item.cited_refs.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {item.cited_refs.map((c) => (
            <span key={`${c.entity_type}:${c.entity_id}`} className="rounded bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs text-zinc-700 dark:text-zinc-300" data-testid="citation">
              {c.label ?? 'A record you cannot see'}
              {c.state_words ? ` (${c.state_words})` : ''}
            </span>
          ))}
        </div>
      )}
      {item.hidden_citation_count > 0 && <p className="text-xs text-zinc-500">{item.hidden_citation_count} citation{item.hidden_citation_count === 1 ? ' was' : 's were'} left out.</p>}
      {item.band_reasons.length > 0 && (
        <ul className="text-xs text-zinc-600 dark:text-zinc-400 list-disc pl-5" data-testid="band-reasons">
          {item.band_reasons.map((r) => (
            <li key={r.code}>{r.words}</li>
          ))}
        </ul>
      )}
      {item.review_status !== 'pending' && (
        <p className="text-xs text-green-700">
          {item.review_status === 'needs_owner' ? `Waiting on ${item.assigned_to_name ?? 'someone'} to answer` : `Reviewed${item.reviewed_by_name ? ` by ${item.reviewed_by_name}` : ''}`}
        </p>
      )}
      {canWrite && !locked && editing && (
        <div className="space-y-2">
          <select className={`${input} w-40`} value={yesNo} onChange={(e) => setYesNo(e.target.value)} aria-label="Yes or No">
            <option value="">No Yes/No</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
          <textarea className={`${input} h-24`} value={text} onChange={(e) => setText(e.target.value)} aria-label="Answer" />
          <div className="flex gap-2">
            <button
              type="button"
              className={primary}
              disabled={review.isPending}
              onClick={() =>
                review.mutate(
                  { id: item.id, review_status: 'edited', final_answer: text.trim() || null, final_yes_no: yesNo === '' ? null : yesNo === 'true' },
                  { onSuccess: () => setEditing(false) },
                )
              }
            >
              Save this answer
            </button>
            <button type="button" className={secondary} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {canWrite && !locked && !editing && (
        <div className="flex gap-2">
          {item.review_status === 'pending' && (shownAnswer || shownYesNo) && (
            <button type="button" className={secondary} disabled={review.isPending} onClick={() => review.mutate({ id: item.id, review_status: 'accepted' })}>
              Use this answer
            </button>
          )}
          <button type="button" className={secondary} onClick={() => setEditing(true)}>
            Edit
          </button>
          {item.review_status !== 'pending' && (
            <button type="button" className={secondary} disabled={review.isPending} onClick={() => review.mutate({ id: item.id, review_status: 'pending' })}>
              Undo review
            </button>
          )}
        </div>
      )}
      {review.error && <p className="text-xs text-red-600">{friendlyError(review.error)}</p>}
    </li>
  );
}

async function downloadAnswers(id: string, format: 'xlsx' | 'csv', title: string) {
  const res = await fetch(`/bastion/api/v1/questionnaires/${id}/export?format=${format}`, { credentials: 'include', headers: { ...impersonateHeader() } });
  if (!res.ok) throw new Error('download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title} (answered).${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

function ReviewStep({ q }: { q: QuestionnaireRow }) {
  const drafting = q.status === 'answering';
  const items = useQuestionnaireItems(q.id, drafting);
  const approve = useApproveQuestionnaire();
  const canApprove = useCan('bastion.questionnaire.approve');
  const canExport = useCan('bastion.questionnaire.export');
  const [filter, setFilter] = useState<'all' | 'needs'>('all');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const impersonating = getImpersonation() !== null;
  const approved = q.status === 'approved' || q.status === 'exported';
  const data = items.data?.data ?? [];
  const approval = items.data?.approval;
  const shown = filter === 'needs' ? data.filter((i) => i.needs_review || i.review_status === 'needs_owner') : data;
  return (
    <section className="space-y-4">
      {drafting && (
        <div className="rounded-lg bg-primary-50 dark:bg-primary-950/30 p-3 text-sm" data-testid="drafting-progress">
          <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
          Bastion is drafting answers: {q.rows_done} of {q.row_count} done, {draftingEstimate(q.row_count - q.rows_done)} left.
        </div>
      )}
      {q.injection_suspected && (
        <p className="text-xs text-amber-700 bg-amber-50 dark:bg-amber-950/30 rounded px-2 py-1">
          Some questions contain text that reads like instructions to a computer. Bastion marked those "Needs an expert"; a person should answer them.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs flex items-center gap-1">
          <input type="checkbox" checked={filter === 'needs'} onChange={(e) => setFilter(e.target.checked ? 'needs' : 'all')} />
          Only answers that still need a person
        </label>
        {!approved && canApprove && (
          <button
            type="button"
            className={primary}
            disabled={!approval?.can_approve || impersonating || approve.isPending}
            title={impersonating ? IMPERSONATING_NOTE : undefined}
            onClick={() => approve.mutate(q.id)}
            data-testid="approve"
          >
            Approve
          </button>
        )}
        {approved && canExport && (
          <>
            <button type="button" className={secondary} onClick={() => downloadAnswers(q.id, 'xlsx', q.title).catch(() => setDownloadError('The download did not work. Please try again.'))}>
              <Download className="inline h-3.5 w-3.5 mr-1" />
              Download answers (Excel)
            </button>
            <button type="button" className={secondary} onClick={() => downloadAnswers(q.id, 'csv', q.title).catch(() => setDownloadError('The download did not work. Please try again.'))}>
              Download answers (CSV)
            </button>
          </>
        )}
      </div>
      {!approved && canApprove && approval && !approval.can_approve && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="approve-blocked">
          Approve is available once these are done: {approval.blocked_because.join('; ')}.
        </p>
      )}
      {!approved && canApprove && impersonating && <p className="text-xs text-amber-700">{IMPERSONATING_NOTE}</p>}
      {approved && (
        <p className="text-sm text-green-700">
          Approved{q.approved_by_name ? ` by ${q.approved_by_name}` : ''}
          {q.approved_at ? ` on ${formatDate(q.approved_at)}` : ''}. The answers were added to the answer library.
        </p>
      )}
      {downloadError && <p className="text-xs text-red-600">{downloadError}</p>}
      {approve.error && <p className="text-xs text-red-600">{friendlyError(approve.error)}</p>}
      {items.isLoading && <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />}
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {shown.map((i) => (
          <ItemRow key={i.id} item={i} questionnaireId={q.id} locked={approved} />
        ))}
      </ul>
    </section>
  );
}

export function QuestionnaireDetailPage({ questionnaireId, onNavigate }: { questionnaireId: string; onNavigate: (path: string) => void }) {
  const q = useQuestionnaire(questionnaireId);
  const autofill = useAutofill();
  const canWrite = useCan('bastion.questionnaire.write');
  const row = q.data?.data;
  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <button type="button" className="text-xs text-zinc-600 flex items-center gap-1" onClick={() => onNavigate('/questionnaires')}>
        <ArrowLeft className="h-3.5 w-3.5" /> All questionnaires
      </button>
      {q.isLoading && <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />}
      {q.error && <p className="text-sm text-red-600">{friendlyError(q.error)}</p>}
      {row && (
        <>
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{row.title}</h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {STATUS_WORDS[row.status]}
              {row.requester_label ? ` · from ${row.requester_label}` : ''}
              {row.due_date ? ` · due ${formatDate(row.due_date)}` : ''}
              {row.rows_done > 0 ? ` · ${row.high_count} Sure, ${row.medium_count} Check this, ${row.low_count} Needs an expert` : ''}
            </p>
          </div>
          {(row.status === 'mapping' || row.status === 'uploaded') && <MappingStep q={row} />}
          {['answering', 'in_review', 'approved', 'exported'].includes(row.status) && <ReviewStep q={row} />}
          {row.status === 'in_review' && canWrite && (
            <button type="button" className={secondary} disabled={autofill.isPending} onClick={() => autofill.mutate({ id: row.id, redraft: true })}>
              Draft again the answers nobody reviewed
            </button>
          )}
          {autofill.error && <p className="text-xs text-red-600">{friendlyError(autofill.error)}</p>}
        </>
      )}
    </div>
  );
}
