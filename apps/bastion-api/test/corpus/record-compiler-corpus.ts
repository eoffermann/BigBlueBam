// Records the compiler corpus (spec 11.3) from a LIVE provider through the platform's internal LLM
// proxy, exactly as bastion-api calls it (same messages, X-Internal-Service: bastion, temperature
// 0). The gate test (compiler-corpus.test.ts) then replays the recording deterministically in CI.
//
//   BASTION_RECORD_API_URL=http://127.0.0.1:14000 \
//   BASTION_RECORD_PROVIDER_ID=<llm_providers.id> INTERNAL_SERVICE_SECRET=<secret> \
//   BASTION_RECORD_MODEL=<model id, for the record> \
//   npx tsx test/corpus/record-compiler-corpus.ts
//
// Progress is logged per control (each call takes 10-20 s; the whole corpus a few minutes).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llmMaxTokens } from '../../src/library/llm-call-settings.js';
import { buildTailoringMessages, TAILORING_PROMPT_VERSION } from '../../src/library/tailoring.js';
import { CORPUS_CONNECTED, CORPUS_PROFILE, corpusControls, type RecordedCorpus } from './compiler-fixtures.js';
import { callLlmProxy, deadlineGate, proxyTargetFromEnv, recordingDeadlineMeta } from './llm-recording.js';

const started = Date.now();
const log = (m: string) => console.log(`[record +${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);

const target = proxyTargetFromEnv();
if (!target) {
  console.error('Set BASTION_RECORD_API_URL, BASTION_RECORD_PROVIDER_ID and INTERNAL_SERVICE_SECRET.');
  process.exit(1);
}
const proxy = target;
const CONCURRENCY = Number(process.env.BASTION_RECORD_CONCURRENCY ?? 3);
// The same budget and deadline production uses (#237, #263, #257): env BASTION_LLM_MAX_TOKENS and
// BASTION_LLM_TIMEOUT_MS, else the constants, read through llm-call-settings.ts. The call itself
// (and its timing, #317) is llm-recording.ts, shared with the live gates. The content is the raw
// model text (#237), so the replay runs normalizeAiText exactly as production does; dashes are kept
// out of the committed file by escaping them when it is written (below).
const MAX_TOKENS = llmMaxTokens('compile', process.env);
const DEADLINE = recordingDeadlineMeta('compile', process.env);

// BASTION_RECORD_LIMIT=n records only the first n controls into compiler-recorded.smoke.json (a
// rehearsal of the whole path before the full recording; never committed).
const LIMIT = Number(process.env.BASTION_RECORD_LIMIT ?? 0);
const controls = LIMIT > 0 ? corpusControls().slice(0, LIMIT) : corpusControls();
const OUT_FILE = LIMIT > 0 ? 'compiler-recorded.smoke.json' : 'compiler-recorded.json';
log(`recording ${controls.length} controls through ${proxy.api} (concurrency ${CONCURRENCY}, max_tokens ${MAX_TOKENS}, deadline ${DEADLINE.deadline_ms} ms; each call 10-60 s)...`);
const out: RecordedCorpus = {
  meta: {
    recorded_at: new Date().toISOString(),
    prompt_version: TAILORING_PROMPT_VERSION,
    model: process.env.BASTION_RECORD_MODEL ?? 'unknown',
    provider_type: process.env.BASTION_RECORD_PROVIDER_TYPE ?? 'unknown',
    max_tokens: MAX_TOKENS,
    ...DEADLINE,
    note: 'Recorded live through apps/api POST /internal/llm/chat with the compile prompt; replayed by compiler-corpus.test.ts.',
  },
  responses: {},
};
let next = 0;
let done = 0;
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= controls.length) return;
    const c = controls[i]!;
    const { messages } = buildTailoringMessages({ control: c.control, requirements: c.requirements, profile: CORPUS_PROFILE, connected: CORPUS_CONNECTED });
    const r = await callLlmProxy(proxy, 'compile', messages);
    out.responses[c.control.control_key] = r;
    done += 1;
    const how = 'finish_reason' in r ? `finish ${r.finish_reason ?? 'null'}, ${r.content.length} chars, ${r.completion_tokens ?? '?'} tokens` : 'error';
    log(`${done}/${controls.length} ${c.control.control_key} (${r.ms ?? '?'} ms, ${how})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const sorted = Object.fromEntries(Object.entries(out.responses).sort(([a], [b]) => a.localeCompare(b)));
// House style for committed files (no em or en dashes) without changing the recorded text: the
// two characters are written as JSON \u escapes, which JSON.parse restores exactly.
const json = JSON.stringify({ ...out, responses: sorted }, null, 2).replace(/—/g, '\\u2014').replace(/–/g, '\\u2013');
writeFileSync(join(import.meta.dirname, OUT_FILE), `${json}\n`);
const values = Object.values(sorted);
const cut = values.filter((v) => 'finish_reason' in v && v.finish_reason === 'length').length;
const failed = values.filter((v) => 'error' in v).length;
log(`wrote ${OUT_FILE} (${values.length} responses; ${cut} cut off at max_tokens, ${failed} failed calls)`);
// The #317 deadline gate, as compiler-corpus.test.ts will run it, so a too-slow recording is seen now.
const gate = deadlineGate({ ...out, responses: sorted }, 'compile', DEADLINE.deadline_ms);
for (const line of gate.report) log(line);
for (const v of gate.violations) log(`DEADLINE GATE: ${v}`);
