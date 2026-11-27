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
import { type BastionLlmCallKind, llmMaxTokens } from '../../src/library/llm-call-settings.js';
import { callLlmProxy, deadlineGate, proxyTargetFromEnv, type RecordedResponse, recordingDeadlineMeta } from './llm-recording.js';
import { CORPUS_QUESTIONS, corpusCandidates, REWORD_DRAFTS, type RecordedQuestionnaireCorpus } from './questionnaire-fixtures.js';

const started = Date.now();
const log = (m: string) => console.log(`[record +${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

const target = proxyTargetFromEnv();
if (!target) {
  console.error('Set BASTION_RECORD_API_URL, BASTION_RECORD_PROVIDER_ID and INTERNAL_SERVICE_SECRET.');
  process.exit(1);
}
const proxy = target;
const CONCURRENCY = Number(process.env.BASTION_RECORD_CONCURRENCY ?? 3);

// The same budget and deadline production uses for each kind (#263, #264, #257; llm-call-settings.ts),
// including an operator override in the environment; each corpus records its budget and deadline
// in meta, and every call its time and completion tokens (#317, llm-recording.ts).
const DRAFT_MAX_TOKENS = llmMaxTokens('questionnaire_draft', process.env);
const REWORD_MAX_TOKENS = llmMaxTokens('fix_reword', process.env);

async function call(kind: BastionLlmCallKind, messages: unknown): Promise<RecordedResponse> {
  const r = await callLlmProxy(proxy, kind, messages);
  // House style for committed files: no em or en dashes (normalizeAiText does the same at run time).
  return 'content' in r ? { ...r, content: r.content.replace(/\s*[—–]\s*/g, ', ') } : r;
}

function logGate(corpus: RecordedQuestionnaireCorpus, kind: BastionLlmCallKind) {
  const gate = deadlineGate(corpus, kind, corpus.meta.deadline_ms ?? 0);
  for (const line of gate.report) log(line);
  for (const v of gate.violations) log(`DEADLINE GATE: ${v}`);
}

const draftDeadline = recordingDeadlineMeta('questionnaire_draft', process.env);
log(`recording ${CORPUS_QUESTIONS.length} questions through ${proxy.api} (concurrency ${CONCURRENCY}, max_tokens ${DRAFT_MAX_TOKENS}, deadline ${draftDeadline.deadline_ms} ms; each call 10-20 s)...`);
const out: RecordedQuestionnaireCorpus = {
  meta: {
    recorded_at: new Date().toISOString(),
    prompt_version: DRAFT_PROMPT_VERSION,
    source: 'live',
    model: process.env.BASTION_RECORD_MODEL_OVERRIDE ?? process.env.BASTION_RECORD_MODEL ?? null,
    max_tokens: DRAFT_MAX_TOKENS,
    ...draftDeadline,
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
    const r = await call('questionnaire_draft', messages);
    out.responses[q.id] = r;
    done += 1;
    log(`${done}/${CORPUS_QUESTIONS.length} ${q.id} (${r.ms ?? '?'} ms, ${'content' in r ? `${r.completion_tokens ?? '?'} tokens` : 'error'})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const sorted = Object.fromEntries(Object.entries(out.responses).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(import.meta.dirname, 'questionnaire-recorded.json'), `${JSON.stringify({ ...out, responses: sorted }, null, 2)}\n`);
log(`wrote questionnaire-recorded.json (${Object.keys(sorted).length} responses)`);
logGate({ ...out, responses: sorted }, 'questionnaire_draft');

// The fix-draft rewording corpus (spec 2.4, 11.3 fix-draft injection), same proxy and settings.
log(`recording ${REWORD_DRAFTS.length} fix-draft rewordings (max_tokens ${REWORD_MAX_TOKENS})...`);
const reword: RecordedQuestionnaireCorpus = {
  meta: {
    ...out.meta,
    prompt_version: REWORD_PROMPT_VERSION,
    max_tokens: REWORD_MAX_TOKENS,
    ...recordingDeadlineMeta('fix_reword', process.env),
    note: 'Recorded live with the fix-draft reword prompt; replayed by questionnaire-corpus.test.ts.',
  },
  responses: {},
};
for (const [i, r] of REWORD_DRAFTS.entries()) {
  const res = await call('fix_reword', buildRewordMessages(r));
  reword.responses[r.id] = res;
  log(`${i + 1}/${REWORD_DRAFTS.length} ${r.id} (${res.ms ?? '?'} ms)`);
}
writeFileSync(join(import.meta.dirname, 'fix-reword-recorded.json'), `${JSON.stringify(reword, null, 2)}\n`);
log('wrote fix-reword-recorded.json');
logGate(reword, 'fix_reword');
