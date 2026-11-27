// Questionnaires and the answer library (spec 2.7; 5.1 rows 72-83).
//
//   GET   /questionnaires                  list (questionnaire.read)
//   POST  /questionnaires                  from a Bin file (xlsx or csv) or pasted rows; Bastion
//                                          guesses the columns and a person checks them
//   GET   /questionnaires/:id              header, mapping preview, counts (row 74)
//   PATCH /questionnaires/:id              details; the mapping while it is being set up (row 75)
//   POST  /questionnaires/:id/autofill     202: the worker drafts every row (row 76)
//   GET   /questionnaires/:id/items        the answer grid; citations re-checked for the reader (row 77)
//   PATCH /questionnaire-items/:id         a person's review of one answer (row 78)
//   POST  /questionnaires/:id/approve      vouching: session, not impersonated, a human (row 79)
//   GET   /questionnaires/:id/export       the questionnaire's own layout, answers written in,
//                                          every cell formula-neutralized (row 80)
//   GET   /answer-library, PATCH /answer-library/:id   rows 82-83
//
// Citations pass can_access at write (the worker, for whoever started the autofill; approval,
// for the approver) and again at read (for whoever reads); a refused citation is never shown.

import { createHash } from 'node:crypto';
import {
  BASTION_CONFIDENCE_WORDS,
  BASTION_QUESTIONNAIRE_MAX_SOURCE_BYTES,
  type BastionAnswerLibraryQuery,
  type BastionAnswerLibraryUpdate,
  type BastionQuestionnaireAutofill,
  type BastionQuestionnaireColumnMap,
  type BastionQuestionnaireCreate,
  type BastionQuestionnaireItemListQuery,
  type BastionQuestionnaireItemReview,
  type BastionQuestionnaireJobData,
  type BastionQuestionnaireListQuery,
  type BastionQuestionnaireUpdate,
  bastionQuestionnaireColumnMapSchema,
} from '@bigbluebam/shared';
import type { StorageDriver } from '@bigbluebam/storage';
import { type EngineDeps, orgTx, type Tx } from '../engine/context.js';
import { auditRaw, viewerKind } from '../lib/audit-raw.js';
import { type BinAccessDeps, resolveBinAssetForEvidence } from '../lib/bin-asset-access.js';
import { ConflictError, NotFoundError, UnavailableError, ValidationFailure } from '../lib/errors.js';
import { enqueueBastionEvent } from '../engine/outbox.js';
import {
  answeredCsv,
  answeredGrid,
  answeredXlsx,
  guessColumnMap,
  itemsFromMap,
  type ParsedQuestionnaire,
  parsePastedQuestionnaire,
  parseQuestionnaireBytes,
  previewSheets,
  type StoredColumnMap,
} from '../library/questionnaire-parse.js';
import { STATE_WORDS, tsQueryTerms } from '../library/questionnaire-draft.js';
import { assertHumanDecider } from './decisions.service.js';
import type { Viewer } from './types.js';

export interface QuestionnaireDeps {
  engine: EngineDeps;
  canAccess: (asker: string, entityType: string, entityId: string) => Promise<boolean>;
  /** The shared uploads bucket Bin writes to; read-only here. */
  binStorage: StorageDriver | null;
  bin: (tx: Tx) => BinAccessDeps;
  enqueueAutofill: (data: BastionQuestionnaireJobData) => Promise<boolean>;
}

const DEFAULT_MAX_ROWS = 1000;
const BIN_READ_TIMEOUT_MS = 15_000;

/* ------------------------------ helpers ------------------------------ */

function storedMap(raw: unknown): StoredColumnMap | null {
  const m = raw as Partial<StoredColumnMap> | null;
  if (!m || !Array.isArray(m.sheets)) return null;
  return { sheets: m.sheets, guessed: m.guessed === true };
}

/**
 * The parsed source grid (bastion_questionnaires.source_grid, #265/#273). Read only where the grid
 * is needed (a mapping change, export, a one-time preview backfill); list and get never load it.
 */
async function loadSource(tx: Tx, orgId: string, id: string): Promise<ParsedQuestionnaire | null> {
  const raw = (await tx`SELECT source_grid FROM bastion_questionnaires WHERE organization_id = ${orgId} AND id = ${id}`)[0]?.source_grid as
    | Partial<ParsedQuestionnaire>
    | null
    | undefined;
  if (!raw || !Array.isArray(raw.sheets)) return null;
  return { format: raw.format === 'xlsx' ? 'xlsx' : 'csv', sheets: raw.sheets, truncated: raw.truncated === true };
}

/** The mapping screen's preview, stored beside the grid; a row from before 0290 computes and stores it once. */
async function loadPreview(tx: Tx, orgId: string, id: string): Promise<ReturnType<typeof previewSheets> | null> {
  const r = (await tx`SELECT source_preview, source_grid IS NOT NULL AS has_grid FROM bastion_questionnaires WHERE organization_id = ${orgId} AND id = ${id}`)[0];
  if (!r) return null;
  if (r.source_preview) return r.source_preview as ReturnType<typeof previewSheets>;
  if (!r.has_grid) return null;
  const src = await loadSource(tx, orgId, id);
  if (!src) return null;
  const preview = previewSheets(src);
  await tx`UPDATE bastion_questionnaires SET source_preview = ${tx.json(preview as never)} WHERE organization_id = ${orgId} AND id = ${id}`;
  return preview;
}

async function maxRows(tx: Tx, orgId: string): Promise<number> {
  const r = (await tx`SELECT max_rows_per_questionnaire FROM bastion_org_settings WHERE organization_id = ${orgId}`)[0];
  return Number(r?.max_rows_per_questionnaire ?? DEFAULT_MAX_ROWS);
}

async function readAll(driver: StorageDriver, key: string, maxBytes: number): Promise<Buffer> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UnavailableError('Bin took too long to hand over the file. Try again in a minute.', 'BIN_UNAVAILABLE')), BIN_READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        const { stream } = await driver.getStream(key);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream as AsyncIterable<Buffer | string>) {
          const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          size += b.length;
          if (size > maxBytes) {
            (stream as { destroy?: () => void }).destroy?.();
            throw new ConflictError('That file is larger than 5 MB, too large for a questionnaire. Save just the questions and try again.', 'QUESTIONNAIRE_TOO_LARGE');
          }
          chunks.push(b);
        }
        return Buffer.concat(chunks);
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function insertItems(tx: Tx, orgId: string, questionnaireId: string, parsed: ParsedQuestionnaire, map: BastionQuestionnaireColumnMap, cap: number) {
  const items = itemsFromMap(parsed, map, cap);
  await tx`DELETE FROM bastion_questionnaire_items WHERE organization_id = ${orgId} AND questionnaire_id = ${questionnaireId}`;
  for (let i = 0; i < items.length; i += 200) {
    const batch = items.slice(i, i + 200).map((it) => ({
      organization_id: orgId,
      questionnaire_id: questionnaireId,
      sheet_name: it.sheet_name,
      row_index: it.row_index,
      section: it.section,
      question_text: it.question_text,
      answer_kind: it.answer_kind,
    }));
    await tx`INSERT INTO bastion_questionnaire_items ${tx(batch as never, 'organization_id', 'questionnaire_id', 'sheet_name', 'row_index', 'section', 'question_text', 'answer_kind')}`;
  }
  return items.length;
}

function shapeQuestionnaire(r: Record<string, unknown>, opts: { preview?: ReturnType<typeof previewSheets> | null } = {}) {
  const map = storedMap(r.column_map);
  const { column_map: _omit, ...rest } = r;
  return {
    ...rest,
    column_map: map ? { sheets: map.sheets, guessed: map.guessed } : null,
    source_truncated: r.source_truncated === true,
    sheet_preview: opts.preview ?? undefined,
    counts_label:
      Number(r.row_count ?? 0) > 0
        ? `${r.rows_done}/${r.row_count} drafted: ${r.high_count} ${BASTION_CONFIDENCE_WORDS.high}, ${r.medium_count} ${BASTION_CONFIDENCE_WORDS.medium}, ${r.low_count} ${BASTION_CONFIDENCE_WORDS.low}`
        : null,
  };
}

const Q_SELECT = `q.id, q.title, q.requester_label, q.bond_deal_id, q.bond_company_id, q.source_bin_asset_id, q.source_bin_asset_version_id,
  q.source_sha256, q.format, q.column_map, q.source_truncated, q.status, q.injection_suspected, q.row_count, q.rows_done, q.low_count, q.medium_count,
  q.high_count, q.resume_count, q.llm_calls_used, q.ai_failure_streak, q.autofill_use_ai, q.due_date::text AS due_date, q.owner_user_id, ou.display_name AS owner_name, q.claimed_by IS NOT NULL AS drafting_now,
  q.approved_by, au.display_name AS approved_by_name, q.approved_at, q.created_by, cu.display_name AS created_by_name, q.created_at, q.updated_at`;
const Q_FROM = `FROM bastion_questionnaires q
  LEFT JOIN users ou ON ou.id = q.owner_user_id
  LEFT JOIN users au ON au.id = q.approved_by
  LEFT JOIN users cu ON cu.id = q.created_by`;

async function loadQ(tx: Tx, orgId: string, id: string, lock = false): Promise<Record<string, unknown>> {
  const r = await tx.unsafe(`SELECT ${Q_SELECT} ${Q_FROM} WHERE q.organization_id = $1 AND q.id = $2 ${lock ? 'FOR UPDATE OF q' : ''}`, [orgId, id]);
  const row = r[0] as Record<string, unknown> | undefined;
  if (!row) throw new NotFoundError('We could not find that questionnaire.');
  return row;
}

async function assertMember(tx: Tx, orgId: string, userId: string, field: string): Promise<void> {
  const r = await tx`SELECT 1 FROM organization_memberships WHERE org_id = ${orgId} AND user_id = ${userId}`;
  if (!r[0]) throw new ValidationFailure('That person is not a member of this organization.', 'NOT_A_MEMBER', [{ field, issue: 'not_a_member' }]);
}

async function assertDeal(d: QuestionnaireDeps, tx: Tx, viewer: Viewer, dealId: string): Promise<void> {
  const r = await tx`SELECT 1 FROM bond_deals WHERE id = ${dealId} AND organization_id = ${viewer.org_id}`;
  const ok = !!r[0] && (await d.canAccess(viewer.id, 'bond.deal', dealId).catch(() => false));
  if (!ok) throw new NotFoundError('We could not find that deal in Bond.');
}

/* ------------------------------ list, get ------------------------------ */

export async function listQuestionnaires(d: QuestionnaireDeps, viewer: Viewer, q: BastionQuestionnaireListQuery) {
  const rows = await orgTx(d.engine.sql, viewer.org_id, (tx) =>
    tx.unsafe(`SELECT ${Q_SELECT} ${Q_FROM} WHERE q.organization_id = $1 AND ($2::text IS NULL OR q.status = $2) ORDER BY q.created_at DESC LIMIT $3`, [
      viewer.org_id,
      q.status ?? null,
      q.limit,
    ]),
  );
  return { data: rows.map((r) => shapeQuestionnaire(r as Record<string, unknown>)), next_cursor: null };
}

export async function getQuestionnaire(d: QuestionnaireDeps, viewer: Viewer, id: string) {
  const { row, preview } = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const r = await loadQ(tx, viewer.org_id, id);
    return { row: r, preview: await loadPreview(tx, viewer.org_id, id) };
  });
  return { data: shapeQuestionnaire(row, { preview }) };
}

/* ------------------------------ create, update ------------------------------ */

export async function createQuestionnaire(d: QuestionnaireDeps, viewer: Viewer, body: BastionQuestionnaireCreate) {
  // Read the source outside the write transaction (a Bin read is a network hop).
  let parsed: ParsedQuestionnaire;
  let sha: string;
  let pinned: { asset_id: string; version_id: string } | null = null;
  const cap = await orgTx(d.engine.sql, viewer.org_id, (tx) => maxRows(tx, viewer.org_id));
  if (body.source.kind === 'bin_asset') {
    const assetId = body.source.bin_asset_id;
    const resolved = await orgTx(d.engine.sql, viewer.org_id, (tx) => resolveBinAssetForEvidence(d.bin(tx), viewer.id, viewer.org_id, assetId));
    if (resolved.decision.action === 'wait') throw new ConflictError('Bin is still checking this file for viruses. Try again in a minute.', 'FILE_NOT_SCANNED_YET');
    if (resolved.decision.action === 'block') throw new ConflictError('Bin flagged this file, so Bastion will not open it.', 'FILE_BLOCKED');
    if (resolved.version.size > BASTION_QUESTIONNAIRE_MAX_SOURCE_BYTES) {
      throw new ConflictError('That file is larger than 5 MB, too large for a questionnaire. Save just the questions and try again.', 'QUESTIONNAIRE_TOO_LARGE');
    }
    if (!d.binStorage) throw new UnavailableError("Bastion can't read files from Bin on this installation (storage isn't set up).", 'BIN_STORAGE_NOT_SET_UP');
    const bytes = await readAll(d.binStorage, resolved.version.object_key, BASTION_QUESTIONNAIRE_MAX_SOURCE_BYTES);
    sha = createHash('sha256').update(bytes).digest('hex');
    parsed = parseQuestionnaireBytes(new Uint8Array(bytes), cap);
    pinned = { asset_id: resolved.asset.id, version_id: resolved.version.id };
  } else {
    sha = createHash('sha256').update(body.source.text, 'utf8').digest('hex');
    parsed = parsePastedQuestionnaire(body.source.text, body.source.format, cap);
  }
  const map = body.column_map ?? guessColumnMap(parsed);
  const stored: StoredColumnMap = { sheets: map.sheets, guessed: !body.column_map };

  const id = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    if (body.bond_deal_id) await assertDeal(d, tx, viewer, body.bond_deal_id);
    if (body.owner_user_id) await assertMember(tx, viewer.org_id, body.owner_user_id, 'owner_user_id');
    const ins = await tx`
      INSERT INTO bastion_questionnaires (organization_id, title, requester_label, bond_deal_id, source_bin_asset_id, source_bin_asset_version_id,
                                          source_sha256, format, column_map, source_grid, source_truncated, source_preview, status, due_date,
                                          owner_user_id, created_by)
      VALUES (${viewer.org_id}, ${body.title}, ${body.requester_label ?? null}, ${body.bond_deal_id ?? null}, ${pinned?.asset_id ?? null},
              ${pinned?.version_id ?? null}, ${sha}, ${parsed.format}, ${tx.json(stored as never)}, ${tx.json(parsed as never)}, ${parsed.truncated},
              ${tx.json(previewSheets(parsed) as never)}, 'mapping', ${body.due_date ?? null}, ${body.owner_user_id ?? viewer.id}, ${viewer.id})
      RETURNING id`;
    const qid = String(ins[0]?.id ?? '');
    if (!qid) throw new Error('bastion_questionnaires insert returned no row');
    const n = await insertItems(tx, viewer.org_id, qid, parsed, map, cap);
    await tx`UPDATE bastion_questionnaires SET row_count = ${n} WHERE id = ${qid}`;
    if (body.bond_deal_id) {
      await tx`
        INSERT INTO entity_links (org_id, src_type, src_id, dst_type, dst_id, link_kind, created_by)
        VALUES (${viewer.org_id}, 'bastion.questionnaire', ${qid}, 'bond.deal', ${body.bond_deal_id}, 'related_to', ${viewer.id})
        ON CONFLICT DO NOTHING`;
    }
    await auditRaw(tx, viewer, 'questionnaire.create', { type: 'questionnaire', id: qid }, { source: body.source.kind, format: parsed.format, rows: n, guessed: stored.guessed });
    return qid;
  });
  return getQuestionnaire(d, viewer, id);
}

export async function updateQuestionnaire(d: QuestionnaireDeps, viewer: Viewer, id: string, body: BastionQuestionnaireUpdate) {
  await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const row = await loadQ(tx, viewer.org_id, id, true);
    if (body.owner_user_id) await assertMember(tx, viewer.org_id, body.owner_user_id, 'owner_user_id');
    if (body.bond_deal_id) await assertDeal(d, tx, viewer, body.bond_deal_id);
    if (body.column_map) {
      if (!['uploaded', 'mapping'].includes(String(row.status))) {
        throw new ConflictError('The columns can only change before answers are drafted. Add the questionnaire again to start over.', 'MAPPING_LOCKED');
      }
      const source = await loadSource(tx, viewer.org_id, id);
      if (!source) throw new ConflictError('This questionnaire has no readable source left; add it again.', 'SOURCE_MISSING');
      const map = bastionQuestionnaireColumnMapSchema.parse(body.column_map);
      // #266: replacing the mapping must not silently drop the questions on sheets it leaves out.
      const kept = new Set(map.sheets.map((s) => s.sheet_name));
      const had = (await tx`SELECT DISTINCT sheet_name FROM bastion_questionnaire_items WHERE organization_id = ${viewer.org_id} AND questionnaire_id = ${id}`).map((r) =>
        String(r.sheet_name),
      );
      const dropped = had.filter((s) => !kept.has(s));
      if (dropped.length > 0 && body.drop_unmapped_sheets !== true) {
        const names = dropped.map((s) => `"${s || 'the pasted rows'}"`).join(', ');
        throw new ConflictError(
          `This mapping leaves out ${dropped.length === 1 ? 'a sheet that holds' : `${dropped.length} sheets that hold`} questions (${names}). Include ${dropped.length === 1 ? 'it' : 'them'}, or confirm you want to drop ${dropped.length === 1 ? 'its' : 'their'} questions.`,
          'SHEETS_DROPPED',
        );
      }
      const n = await insertItems(tx, viewer.org_id, id, source, map, await maxRows(tx, viewer.org_id));
      // Only the mapping keys change; anything else column_map carries (autofill_requested_by) stays.
      await tx`UPDATE bastion_questionnaires
                  SET column_map = column_map || ${tx.json({ sheets: map.sheets, guessed: false } as never)}, row_count = ${n}, rows_done = 0,
                      high_count = 0, medium_count = 0, low_count = 0, status = 'mapping' WHERE id = ${id}`;
    }
    const sets: string[] = [];
    const vals: unknown[] = [viewer.org_id, id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (body.title !== undefined) set('title', body.title);
    if (body.requester_label !== undefined) set('requester_label', body.requester_label);
    if (body.due_date !== undefined) set('due_date', body.due_date);
    if (body.owner_user_id !== undefined) set('owner_user_id', body.owner_user_id);
    if (body.bond_deal_id !== undefined) set('bond_deal_id', body.bond_deal_id);
    if (sets.length > 0) await tx.unsafe(`UPDATE bastion_questionnaires SET ${sets.join(', ')} WHERE organization_id = $1 AND id = $2`, vals as never[]);
    if (body.bond_deal_id) {
      await tx`
        INSERT INTO entity_links (org_id, src_type, src_id, dst_type, dst_id, link_kind, created_by)
        VALUES (${viewer.org_id}, 'bastion.questionnaire', ${id}, 'bond.deal', ${body.bond_deal_id}, 'related_to', ${viewer.id})
        ON CONFLICT DO NOTHING`;
    }
    await auditRaw(tx, viewer, 'questionnaire.update', { type: 'questionnaire', id }, { fields: Object.keys(body) });
  });
  return getQuestionnaire(d, viewer, id);
}

/* ------------------------------ autofill ------------------------------ */

export async function startAutofill(d: QuestionnaireDeps, viewer: Viewer, id: string, body: BastionQuestionnaireAutofill) {
  const resume = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const row = await loadQ(tx, viewer.org_id, id, true);
    const status = String(row.status);
    if (status === 'answering') throw new ConflictError('Bastion is already drafting this questionnaire.', 'AUTOFILL_RUNNING');
    if (!['uploaded', 'mapping', 'in_review'].includes(status)) {
      throw new ConflictError('This questionnaire was approved; add it again to draft new answers.', 'QUESTIONNAIRE_APPROVED');
    }
    if (Number(row.row_count) === 0) throw new ConflictError('There are no questions to answer. Check which column holds the questions.', 'QUESTIONNAIRE_EMPTY');
    if (body.redraft) {
      await tx`
        UPDATE bastion_questionnaire_items
           SET draft_answer = NULL, draft_yes_no = NULL, cited_refs = '[]'::jsonb, dropped_citation_count = 0, confidence = NULL,
               confidence_band = NULL, band_reasons = '[]'::jsonb
         WHERE organization_id = ${viewer.org_id} AND questionnaire_id = ${id} AND review_status = 'pending'`;
    }
    const left = await tx`
      SELECT count(*)::int AS n FROM bastion_questionnaire_items WHERE organization_id = ${viewer.org_id} AND questionnaire_id = ${id} AND confidence_band IS NULL`;
    if (Number(left[0]?.n ?? 0) === 0) throw new ConflictError('Every question already has a draft. Ask for new drafts to replace the ones nobody reviewed.', 'NOTHING_TO_DRAFT');
    // The person who asked is the asker for can_access on every citation the worker writes. A new
    // run starts with no failed AI calls behind it (#260); llm_calls_used is NOT reset: the
    // per-questionnaire allowance covers every run, redrafts included (#261).
    await tx`
      UPDATE bastion_questionnaires
         SET status = 'answering', claimed_by = NULL, heartbeat_at = NULL, slice_token = NULL, resume_count = 0,
             ai_failure_streak = 0, last_ai_failure = NULL, autofill_generation = autofill_generation + 1,
             autofill_use_ai = ${body.use_ai !== false},
             column_map = jsonb_set(column_map, '{autofill_requested_by}', to_jsonb(${viewer.id}::text))
       WHERE organization_id = ${viewer.org_id} AND id = ${id}`;
    await auditRaw(tx, viewer, 'questionnaire.autofill_start', { type: 'questionnaire', id }, { redraft: body.redraft, use_ai: body.use_ai !== false, kind: await viewerKind(tx, viewer) });
    return 0;
  });
  const queued = await d.enqueueAutofill({ organization_id: viewer.org_id, questionnaire_id: id, resume_count: resume });
  d.engine.log.info({ questionnaire_id: id, queued }, 'bastion-autofill: queued for the worker');
  return getQuestionnaire(d, viewer, id);
}

/* ------------------------------ items ------------------------------ */

const ITEM_SELECT = `i.id, i.questionnaire_id, i.sheet_name, i.row_index, i.section, i.question_text, i.answer_kind, i.draft_answer, i.draft_yes_no,
  i.final_answer, i.final_yes_no, i.cited_refs, i.dropped_citation_count, i.confidence, i.confidence_band, i.band_reasons, i.review_status,
  i.assigned_to, au.display_name AS assigned_to_name, i.reviewed_by, ru.display_name AS reviewed_by_name, i.reviewed_at`;

/** Names for cited controls and policies, for the chips. */
async function citationLabels(tx: Tx, orgId: string, refs: Array<{ entity_type: string; entity_id: string }>) {
  const controls = refs.filter((r) => r.entity_type === 'bastion.control').map((r) => r.entity_id);
  const policies = refs.filter((r) => r.entity_type === 'bastion.policy').map((r) => r.entity_id);
  const out = new Map<string, { label: string; state: string | null }>();
  if (controls.length > 0) {
    const rows = await tx`SELECT id, title, status FROM bastion_controls WHERE organization_id = ${orgId} AND id = ANY(${controls}::uuid[])`;
    for (const r of rows) out.set(`bastion.control:${r.id}`, { label: String(r.title), state: String(r.status) });
  }
  if (policies.length > 0) {
    const rows = await tx`
      SELECT p.id, be.title FROM bastion_policies p JOIN beacon_entries be ON be.id = p.beacon_entry_id AND be.organization_id = p.organization_id
       WHERE p.organization_id = ${orgId} AND p.id = ANY(${policies}::uuid[])`;
    for (const r of rows) out.set(`bastion.policy:${r.id}`, { label: String(r.title), state: null });
  }
  return out;
}

/** can_access for the reader and, when an agent reads for someone, the asker too (narrows, never widens). */
function visibilityCheck(d: QuestionnaireDeps, viewer: Viewer, asker: string | null) {
  const cache = new Map<string, boolean>();
  return async (ref: { entity_type: string; entity_id: string }) => {
    const k = `${ref.entity_type}:${ref.entity_id}`;
    let ok = cache.get(k);
    if (ok === undefined) {
      ok = await d.canAccess(viewer.id, ref.entity_type, ref.entity_id).catch(() => false);
      if (ok && asker && asker !== viewer.id) ok = await d.canAccess(asker, ref.entity_type, ref.entity_id).catch(() => false);
      cache.set(k, ok);
    }
    return ok;
  };
}

async function shapeItems(d: QuestionnaireDeps, viewer: Viewer, tx: Tx, rows: Record<string, unknown>[], asker: string | null = null) {
  const all = rows.flatMap((r) => (r.cited_refs as Array<{ entity_type: string; entity_id: string }> | null) ?? []);
  const labels = await citationLabels(tx, viewer.org_id, all);
  const visibleTo = visibilityCheck(d, viewer, asker);
  const out = [];
  for (const r of rows) {
    const refs = (r.cited_refs as Array<{ entity_type: string; entity_id: string }> | null) ?? [];
    const visible = [];
    for (const ref of refs) {
      const k = `${ref.entity_type}:${ref.entity_id}`;
      const ok = await visibleTo(ref);
      if (ok) visible.push({ ...ref, label: labels.get(k)?.label ?? null, state_words: labels.get(k)?.state ? (STATE_WORDS[labels.get(k)?.state as string] ?? null) : null });
    }
    const band = r.confidence_band as keyof typeof BASTION_CONFIDENCE_WORDS | null;
    out.push({
      ...r,
      confidence: r.confidence === null ? null : Number(r.confidence),
      cited_refs: visible,
      hidden_citation_count: refs.length - visible.length + Number(r.dropped_citation_count ?? 0),
      confidence_words: band ? BASTION_CONFIDENCE_WORDS[band] : null,
      needs_review: r.review_status === 'pending' && band === 'low',
    });
  }
  return out;
}

export async function listItems(d: QuestionnaireDeps, viewer: Viewer, id: string, q: BastionQuestionnaireItemListQuery, asker: string | null = null) {
  return orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    await loadQ(tx, viewer.org_id, id);
    const rows = await tx.unsafe(
      `SELECT ${ITEM_SELECT} FROM bastion_questionnaire_items i
         LEFT JOIN users au ON au.id = i.assigned_to LEFT JOIN users ru ON ru.id = i.reviewed_by
        WHERE i.organization_id = $1 AND i.questionnaire_id = $2 AND ($3::text IS NULL OR i.confidence_band = $3)
          AND ($4::text IS NULL OR i.review_status = $4)
          AND ($5::boolean IS NULL OR (i.review_status = 'pending' AND i.confidence_band = 'low') = $5)
        ORDER BY i.sheet_name, i.row_index`,
      [viewer.org_id, id, q.band ?? null, q.review_status ?? null, q.needs_review ?? null],
    );
    const data = await shapeItems(d, viewer, tx, rows as unknown as Record<string, unknown>[], asker);
    const blocking = await approvalBlockers(tx, viewer.org_id, id);
    return { data, approval: blocking, next_cursor: null };
  });
}

/** What still stands between this questionnaire and approval (spec 2.7 step 7, story 7). */
async function approvalBlockers(tx: Tx, orgId: string, id: string) {
  const r = (await tx`
    SELECT count(*) FILTER (WHERE confidence_band = 'low' AND review_status = 'pending')::int AS low_unreviewed,
           count(*) FILTER (WHERE review_status = 'needs_owner')::int AS waiting_on_owner,
           count(*) FILTER (WHERE confidence_band IS NULL)::int AS undrafted,
           count(*) FILTER (WHERE confidence_band = 'medium' AND review_status = 'pending')::int AS medium_unreviewed
      FROM bastion_questionnaire_items WHERE organization_id = ${orgId} AND questionnaire_id = ${id}`)[0] as {
    low_unreviewed: number;
    waiting_on_owner: number;
    undrafted: number;
    medium_unreviewed: number;
  };
  const reasons: string[] = [];
  if (r.undrafted > 0) reasons.push(`${r.undrafted} question${r.undrafted === 1 ? ' has' : 's have'} no draft yet`);
  if (r.low_unreviewed > 0) reasons.push(`${r.low_unreviewed} "${BASTION_CONFIDENCE_WORDS.low}" answer${r.low_unreviewed === 1 ? '' : 's'} still to review`);
  if (r.waiting_on_owner > 0) reasons.push(`${r.waiting_on_owner} answer${r.waiting_on_owner === 1 ? ' is' : 's are'} waiting on someone to answer`);
  return { ...r, can_approve: reasons.length === 0, blocked_because: reasons };
}

export async function reviewItem(d: QuestionnaireDeps, viewer: Viewer, itemId: string, body: BastionQuestionnaireItemReview) {
  const qid = await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const it = (await tx`
      SELECT i.id, i.questionnaire_id, i.confidence_band, i.draft_answer, i.draft_yes_no, q.status
        FROM bastion_questionnaire_items i JOIN bastion_questionnaires q ON q.id = i.questionnaire_id AND q.organization_id = i.organization_id
       WHERE i.organization_id = ${viewer.org_id} AND i.id = ${itemId} FOR UPDATE OF q`)[0];
    if (!it) throw new NotFoundError('We could not find that question.');
    if (['approved', 'exported'].includes(String(it.status))) throw new ConflictError('This questionnaire is already approved.', 'QUESTIONNAIRE_APPROVED');
    if (it.confidence_band === null && body.review_status !== 'needs_owner' && body.review_status !== 'edited') {
      throw new ConflictError('This question has no draft yet. Write the answer, or ask someone to.', 'NOT_DRAFTED');
    }
    if (body.assigned_to) await assertMember(tx, viewer.org_id, body.assigned_to, 'assigned_to');
    const now = d.engine.now();
    let finalAnswer: string | null = null;
    let finalYesNo: boolean | null = null;
    if (body.review_status === 'accepted') {
      finalAnswer = (it.draft_answer as string | null) ?? null;
      finalYesNo = (it.draft_yes_no as boolean | null) ?? null;
      if (finalAnswer === null && finalYesNo === null) throw new ConflictError('There is no drafted answer to accept. Write one instead.', 'NOTHING_TO_ACCEPT');
    } else if (body.review_status === 'edited') {
      finalAnswer = body.final_answer ?? (it.draft_answer as string | null) ?? null;
      finalYesNo = body.final_yes_no !== undefined ? body.final_yes_no : ((it.draft_yes_no as boolean | null) ?? null);
    }
    const pending = body.review_status === 'pending';
    await tx`
      UPDATE bastion_questionnaire_items
         SET review_status = ${body.review_status}, final_answer = ${finalAnswer}, final_yes_no = ${finalYesNo},
             assigned_to = ${body.review_status === 'needs_owner' ? (body.assigned_to ?? null) : (body.assigned_to ?? null)},
             reviewed_by = ${pending ? null : viewer.id}, reviewed_at = ${pending ? null : now}
       WHERE organization_id = ${viewer.org_id} AND id = ${itemId}`;
    await auditRaw(tx, viewer, 'questionnaire.item_review', { type: 'questionnaire_item', id: itemId }, { review_status: body.review_status });
    return String(it.questionnaire_id);
  });
  const items = await listItems(d, viewer, qid, {});
  const item = items.data.find((x) => (x as unknown as { id: string }).id === itemId);
  return { data: item, approval: items.approval };
}

/* ------------------------------ approve ------------------------------ */

/**
 * Row 79: the release gate (spec 2.7 step 7). Session, not impersonated, a human (the route and
 * assertHumanDecider). Every "Needs an expert" row must be reviewed and nothing may be waiting on
 * someone; the approver's approval accepts the remaining drafts as they stand (recorded on each
 * row). Approved answers enter the answer library with their citations re-checked for the approver.
 */
export async function approveQuestionnaire(d: QuestionnaireDeps, viewer: Viewer, id: string) {
  await orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    await assertHumanDecider(tx, viewer);
    const row = await loadQ(tx, viewer.org_id, id, true);
    const status = String(row.status);
    if (status === 'answering') throw new ConflictError('Bastion is still drafting answers. Approve when it has finished.', 'AUTOFILL_RUNNING');
    if (['approved', 'exported'].includes(status)) throw new ConflictError('This questionnaire is already approved.', 'QUESTIONNAIRE_APPROVED');
    if (status !== 'in_review') throw new ConflictError('Draft the answers before approving.', 'NOT_DRAFTED');
    const b = await approvalBlockers(tx, viewer.org_id, id);
    if (!b.can_approve) throw new ConflictError(`Not yet: ${b.blocked_because.join('; ')}.`, 'REVIEW_NOT_DONE');
    const now = d.engine.now();
    await tx`
      UPDATE bastion_questionnaire_items
         SET review_status = 'accepted', final_answer = draft_answer, final_yes_no = draft_yes_no, reviewed_by = ${viewer.id}, reviewed_at = ${now}
       WHERE organization_id = ${viewer.org_id} AND questionnaire_id = ${id} AND review_status = 'pending'`;
    const items = await tx`
      SELECT id, question_text, final_answer, final_yes_no, cited_refs FROM bastion_questionnaire_items
       WHERE organization_id = ${viewer.org_id} AND questionnaire_id = ${id} AND (final_answer IS NOT NULL OR final_yes_no IS NOT NULL)`;
    let learned = 0;
    const cache = new Map<string, boolean>();
    for (const it of items) {
      const refs = ((it.cited_refs as Array<{ entity_type: string; entity_id: string }> | null) ?? []).filter((r) => r.entity_type.includes('.'));
      const kept = [];
      for (const r of refs) {
        const k = `${r.entity_type}:${r.entity_id}`;
        let ok = cache.get(k);
        if (ok === undefined) {
          ok = await d.canAccess(viewer.id, r.entity_type, r.entity_id).catch(() => false);
          cache.set(k, ok);
        }
        if (ok) kept.push({ entity_type: r.entity_type, entity_id: r.entity_id });
      }
      const text = String(it.final_answer ?? (it.final_yes_no === true ? 'Yes' : it.final_yes_no === false ? 'No' : '')).trim();
      if (!text) continue;
      await tx`
        UPDATE bastion_answer_library SET retired_at = ${now}
         WHERE organization_id = ${viewer.org_id} AND retired_at IS NULL AND lower(btrim(question_text)) = lower(btrim(${String(it.question_text)}))`;
      await tx`
        INSERT INTO bastion_answer_library (organization_id, question_text, answer_text, yes_no, cited_refs, source_item_id, approved_by, approved_at)
        VALUES (${viewer.org_id}, ${String(it.question_text)}, ${text}, ${(it.final_yes_no as boolean | null) ?? null}, ${tx.json(kept as never)},
                ${it.id as string}, ${viewer.id}, ${now})`;
      learned += 1;
    }
    await tx`UPDATE bastion_questionnaires SET status = 'approved', approved_by = ${viewer.id}, approved_at = ${now} WHERE id = ${id}`;
    await enqueueBastionEvent(
      'questionnaire.approved',
      // #262: declared in the catalog; refs and counts only (spec 8.1), no customer-supplied title.
      { questionnaire_id: id, approved_by: viewer.id, row_count: Number(row.row_count), learned },
      tx,
      { orgId: viewer.org_id, idempotencyKey: `questionnaire.approved:${id}`, actorId: viewer.id, actorType: 'user' },
    );
    await auditRaw(tx, viewer, 'questionnaire.approve', { type: 'questionnaire', id }, { learned, medium_accepted_by_approval: b.medium_unreviewed });
  });
  return getQuestionnaire(d, viewer, id);
}

/* ------------------------------ export ------------------------------ */

export async function exportQuestionnaire(d: QuestionnaireDeps, viewer: Viewer, id: string, format?: 'xlsx' | 'csv') {
  return orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const row = await loadQ(tx, viewer.org_id, id, true);
    if (!['approved', 'exported'].includes(String(row.status))) {
      throw new ConflictError('Approve the answers before downloading them.', 'NOT_APPROVED');
    }
    const map = storedMap(row.column_map);
    const source = await loadSource(tx, viewer.org_id, id);
    if (!map || !source) throw new ConflictError('This questionnaire has no readable source left; add it again.', 'SOURCE_MISSING');
    const items = await tx`
      SELECT sheet_name, row_index, final_answer, final_yes_no FROM bastion_questionnaire_items
       WHERE organization_id = ${viewer.org_id} AND questionnaire_id = ${id}`;
    const grid = answeredGrid(
      source,
      map,
      items.map((i) => ({ sheet_name: String(i.sheet_name), row_index: Number(i.row_index), answer: (i.final_answer as string | null) ?? null, yes_no: (i.final_yes_no as boolean | null) ?? null })),
    );
    const fmt = format ?? (String(row.format) === 'xlsx' ? 'xlsx' : 'csv');
    if (String(row.status) === 'approved') await tx`UPDATE bastion_questionnaires SET status = 'exported' WHERE id = ${id}`;
    await auditRaw(tx, viewer, 'questionnaire.export', { type: 'questionnaire', id }, { format: fmt });
    const base = String(row.title).replace(/[^A-Za-z0-9 _.-]+/g, ' ').trim().slice(0, 80) || 'questionnaire';
    return fmt === 'xlsx'
      ? { filename: `${base} (answered).xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from(answeredXlsx(grid)) }
      : { filename: `${base} (answered).csv`, contentType: 'text/csv; charset=utf-8', body: Buffer.from(`﻿${answeredCsv(grid)}`, 'utf8') };
  });
}

/* ------------------------------ answer library ------------------------------ */

export async function listAnswerLibrary(d: QuestionnaireDeps, viewer: Viewer, q: BastionAnswerLibraryQuery, asker: string | null = null) {
  return orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const terms = q.q ? tsQueryTerms(q.q) : '';
    const rows = await tx.unsafe(
      `SELECT l.id, l.question_text, l.answer_text, l.yes_no, l.cited_refs, l.source_item_id, l.approved_by, u.display_name AS approved_by_name,
              l.approved_at, l.stale, l.stale_reason, l.retired_at, l.created_at, l.updated_at
              ${terms ? `, ts_rank_cd(l.tsv, to_tsquery('english', $5)) AS rank` : ', 0 AS rank'}
         FROM bastion_answer_library l LEFT JOIN users u ON u.id = l.approved_by
        WHERE l.organization_id = $1 AND ($2::boolean OR l.retired_at IS NULL) AND ($3::boolean OR NOT l.stale)
          ${terms ? `AND l.tsv @@ to_tsquery('english', $5)` : ''}
        ORDER BY rank DESC, l.approved_at DESC NULLS LAST LIMIT $4`,
      terms ? [viewer.org_id, q.include_retired ?? false, q.include_stale ?? true, q.limit, terms] : [viewer.org_id, q.include_retired ?? false, q.include_stale ?? true, q.limit],
    );
    const shaped = await shapeLibrary(d, viewer, tx, rows as unknown as Record<string, unknown>[], asker);
    return { data: shaped, next_cursor: null };
  });
}

async function shapeLibrary(d: QuestionnaireDeps, viewer: Viewer, tx: Tx, rows: Record<string, unknown>[], asker: string | null = null) {
  const all = rows.flatMap((r) => (r.cited_refs as Array<{ entity_type: string; entity_id: string }> | null) ?? []);
  const labels = await citationLabels(tx, viewer.org_id, all);
  const visibleTo = visibilityCheck(d, viewer, asker);
  const out = [];
  for (const r of rows) {
    const refs = (r.cited_refs as Array<{ entity_type: string; entity_id: string }> | null) ?? [];
    const visible = [];
    for (const ref of refs) {
      if (await visibleTo(ref)) {
        visible.push({ ...ref, label: labels.get(`${ref.entity_type}:${ref.entity_id}`)?.label ?? null });
      }
    }
    out.push({
      ...r,
      rank: Number(r.rank ?? 0),
      cited_refs: visible,
      hidden_citation_count: refs.length - visible.length,
      stale_words: r.stale ? 'A control this answer relies on changed since it was approved. Check it still holds.' : null,
    });
  }
  return out;
}

export async function updateAnswerLibrary(d: QuestionnaireDeps, viewer: Viewer, id: string, body: BastionAnswerLibraryUpdate) {
  return orgTx(d.engine.sql, viewer.org_id, async (tx) => {
    const cur = (await tx`SELECT id FROM bastion_answer_library WHERE organization_id = ${viewer.org_id} AND id = ${id} FOR UPDATE`)[0];
    if (!cur) throw new NotFoundError('We could not find that answer.');
    const now = d.engine.now();
    if (body.answer_text !== undefined) await tx`UPDATE bastion_answer_library SET answer_text = ${body.answer_text}, approved_by = ${viewer.id}, approved_at = ${now} WHERE id = ${id}`;
    if (body.yes_no !== undefined) await tx`UPDATE bastion_answer_library SET yes_no = ${body.yes_no} WHERE id = ${id}`;
    if (body.stale === false) await tx`UPDATE bastion_answer_library SET stale = false, stale_reason = NULL, approved_by = ${viewer.id}, approved_at = ${now} WHERE id = ${id}`;
    if (body.retired !== undefined) await tx`UPDATE bastion_answer_library SET retired_at = ${body.retired ? now : null} WHERE id = ${id}`;
    await auditRaw(tx, viewer, 'answer_library.update', { type: 'answer_library', id }, { fields: Object.keys(body) });
    const rows = await tx`
      SELECT l.id, l.question_text, l.answer_text, l.yes_no, l.cited_refs, l.source_item_id, l.approved_by, u.display_name AS approved_by_name,
             l.approved_at, l.stale, l.stale_reason, l.retired_at, l.created_at, l.updated_at, 0 AS rank
        FROM bastion_answer_library l LEFT JOIN users u ON u.id = l.approved_by WHERE l.id = ${id}`;
    const [shaped] = await shapeLibrary(d, viewer, tx, rows as unknown as Record<string, unknown>[]);
    return { data: shaped };
  });
}
