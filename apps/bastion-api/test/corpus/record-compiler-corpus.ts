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
// The same budget production uses (#237, #263): env BASTION_LLM_MAX_TOKENS, else the one constant,
// read through llm-call-settings.ts with the bounds env.ts applies.
const MAX_TOKENS = llmMaxTokens('compile', process.env);

async function call(messages: unknown): Promise<{ content: string; finish_reason: string | null }> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${api}/internal/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret, 'X-Internal-Service': 'bastion' },
      // BASTION_RECORD_MODEL_OVERRIDE uses the proxy's optional `model` field (same provider key),
      // for when the provider row names a model its host has retired.
      body: JSON.stringify({
        provider_id: provider,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        ...(process.env.BASTION_RECORD_MODEL_OVERRIDE ? { model: process.env.BASTION_RECORD_MODEL_OVERRIDE } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.status === 429 && attempt < 10) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`proxy returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: { content?: string; finish_reason?: string | null } };
    // The raw model text (#237), so the replay runs normalizeAiText exactly as production does.
    // Dashes are kept out of the committed file by escaping them when it is written (below).
    return { content: body.data?.content ?? '', finish_reason: body.data?.finish_reason ?? null };
  }
}

// BASTION_RECORD_LIMIT=n records only the first n controls into compiler-recorded.smoke.json (a
// rehearsal of the whole path before the full recording; never committed).
const LIMIT = Number(process.env.BASTION_RECORD_LIMIT ?? 0);
const controls = LIMIT > 0 ? corpusControls().slice(0, LIMIT) : corpusControls();
const OUT_FILE = LIMIT > 0 ? 'compiler-recorded.smoke.json' : 'compiler-recorded.json';
log(`recording ${controls.length} controls through ${api} (concurrency ${CONCURRENCY}, max_tokens ${MAX_TOKENS}; each call 10-60 s)...`);
const out: RecordedCorpus = {
  meta: {
    recorded_at: new Date().toISOString(),
    prompt_version: TAILORING_PROMPT_VERSION,
    model: process.env.BASTION_RECORD_MODEL ?? 'unknown',
    provider_type: process.env.BASTION_RECORD_PROVIDER_TYPE ?? 'unknown',
    max_tokens: MAX_TOKENS,
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
    const t = Date.now();
    try {
      out.responses[c.control.control_key] = await call(messages);
    } catch (err) {
      out.responses[c.control.control_key] = { error: (err as Error).message };
    }
    done += 1;
    const r = out.responses[c.control.control_key];
    const how = r && 'finish_reason' in r ? `finish ${r.finish_reason ?? 'null'}, ${r.content.length} chars` : 'error';
    log(`${done}/${controls.length} ${c.control.control_key} (${Date.now() - t} ms, ${how})`);
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
