// Records the questionnaire corpus (spec 11.3) from a LIVE provider through the platform's internal
// LLM proxy, exactly as bastion-api calls it (the production draft prompt, X-Internal-Service:
// bastion, temperature 0). questionnaire-corpus.test.ts then replays the recording in CI.
//
//   BASTION_RECORD_API_URL=http://127.0.0.1:14000 \
//   BASTION_RECORD_PROVIDER_ID=<llm_providers.id> INTERNAL_SERVICE_SECRET=<secret> \
//   BASTION_RECORD_MODEL=<model id, for the record> [BASTION_RECORD_MODEL_OVERRIDE=<model>] \
//   npx tsx test/corpus/record-questionnaire-corpus.ts
//
// Progress is logged per question (each call takes 10-20 s; the whole corpus a few minutes).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDraftMessages, DRAFT_PROMPT_VERSION } from '../../src/library/questionnaire-draft.js';
import { buildRewordMessages, REWORD_PROMPT_VERSION } from '../../src/library/fix-reword.js';
import { type BastionLlmCallKind, llmDeadlineMs, llmMaxTokens } from '../../src/library/llm-call-settings.js';
import { CORPUS_QUESTIONS, corpusCandidates, REWORD_DRAFTS, type RecordedQuestionnaireCorpus } from './questionnaire-fixtures.js';

const started = Date.now();
const log = (m: string) => console.log(`[record +${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

const api = (process.env.BASTION_RECORD_API_URL ?? '').replace(/\/+$/, '');
const provider = process.env.BASTION_RECORD_PROVIDER_ID ?? '';
const secret = process.env.INTERNAL_SERVICE_SECRET ?? '';
if (!api || !provider || !secret) {
  console.error('Set BASTION_RECORD_API_URL, BASTION_RECORD_PROVIDER_ID and INTERNAL_SERVICE_SECRET.');
  process.exit(1);
}
const CONCURRENCY = Number(process.env.BASTION_RECORD_CONCURRENCY ?? 3);

// The same budget and deadline production uses for each kind (#263, #264; llm-call-settings.ts),
// including an operator override in the environment; each corpus records its budget in meta.
const DRAFT_MAX_TOKENS = llmMaxTokens('questionnaire_draft', process.env);
const REWORD_MAX_TOKENS = llmMaxTokens('fix_reword', process.env);

async function call(kind: BastionLlmCallKind, messages: unknown): Promise<{ content: string; finish_reason: string | null }> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${api}/internal/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret, 'X-Internal-Service': 'bastion' },
      body: JSON.stringify({
        provider_id: provider,
        messages,
        max_tokens: llmMaxTokens(kind, process.env),
        temperature: 0,
        ...(process.env.BASTION_RECORD_MODEL_OVERRIDE ? { model: process.env.BASTION_RECORD_MODEL_OVERRIDE } : {}),
      }),
      signal: AbortSignal.timeout(llmDeadlineMs(kind, process.env)),
    });
    if (res.status === 429 && attempt < 10) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`proxy returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: { content?: string; finish_reason?: string | null } };
    // House style for committed files: no em or en dashes (normalizeAiText does the same at run time).
    const content = (body.data?.content ?? '').replace(/\s*[—–]\s*/g, ', ');
    return { content, finish_reason: body.data?.finish_reason ?? null };
  }
}

log(`recording ${CORPUS_QUESTIONS.length} questions through ${api} (concurrency ${CONCURRENCY}, max_tokens ${DRAFT_MAX_TOKENS}; each call 10-20 s)...`);
const out: RecordedQuestionnaireCorpus = {
  meta: {
    recorded_at: new Date().toISOString(),
    prompt_version: DRAFT_PROMPT_VERSION,
    source: 'live',
    model: process.env.BASTION_RECORD_MODEL_OVERRIDE ?? process.env.BASTION_RECORD_MODEL ?? null,
    max_tokens: DRAFT_MAX_TOKENS,
    note: 'Recorded live through apps/api POST /internal/llm/chat with the questionnaire draft prompt; replayed by questionnaire-corpus.test.ts.',
  },
  responses: {},
};
let next = 0;
let done = 0;
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= CORPUS_QUESTIONS.length) return;
    const q = CORPUS_QUESTIONS[i]!;
    const messages = buildDraftMessages({ question: q.question, section: null, answer_kind: q.answer_kind, candidates: corpusCandidates(q) });
    const t = Date.now();
    try {
      out.responses[q.id] = await call('questionnaire_draft', messages);
    } catch (err) {
      out.responses[q.id] = { error: (err as Error).message };
    }
    done += 1;
    log(`${done}/${CORPUS_QUESTIONS.length} ${q.id} (${Date.now() - t} ms)`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const sorted = Object.fromEntries(Object.entries(out.responses).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(import.meta.dirname, 'questionnaire-recorded.json'), `${JSON.stringify({ ...out, responses: sorted }, null, 2)}\n`);
log(`wrote questionnaire-recorded.json (${Object.keys(sorted).length} responses)`);

// The fix-draft rewording corpus (spec 2.4, 11.3 fix-draft injection), same proxy and settings.
log(`recording ${REWORD_DRAFTS.length} fix-draft rewordings (max_tokens ${REWORD_MAX_TOKENS})...`);
const reword: RecordedQuestionnaireCorpus = {
  meta: {
    ...out.meta,
    prompt_version: REWORD_PROMPT_VERSION,
    max_tokens: REWORD_MAX_TOKENS,
    note: 'Recorded live with the fix-draft reword prompt; replayed by questionnaire-corpus.test.ts.',
  },
  responses: {},
};
for (const [i, r] of REWORD_DRAFTS.entries()) {
  const t = Date.now();
  try {
    reword.responses[r.id] = await call('fix_reword', buildRewordMessages(r));
  } catch (err) {
    reword.responses[r.id] = { error: (err as Error).message };
  }
  log(`${i + 1}/${REWORD_DRAFTS.length} ${r.id} (${Date.now() - t} ms)`);
}
writeFileSync(join(import.meta.dirname, 'fix-reword-recorded.json'), `${JSON.stringify(reword, null, 2)}\n`);
log('wrote fix-reword-recorded.json');
