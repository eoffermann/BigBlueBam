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
        max_tokens: 2048,
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
    // House style for committed files: no em or en dashes (normalizeAiText does the same at run time).
    const content = (body.data?.content ?? '').replace(/\s*[\u2014\u2013]\s*/g, ', ');
    return { content, finish_reason: body.data?.finish_reason ?? null };
  }
}

const controls = corpusControls();
log(`recording ${controls.length} controls through ${api} (concurrency ${CONCURRENCY}; each call 10-20 s)...`);
const out: RecordedCorpus = {
  meta: {
    recorded_at: new Date().toISOString(),
    prompt_version: TAILORING_PROMPT_VERSION,
    model: process.env.BASTION_RECORD_MODEL ?? 'unknown',
    provider_type: process.env.BASTION_RECORD_PROVIDER_TYPE ?? 'unknown',
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
    log(`${done}/${controls.length} ${c.control.control_key} (${Date.now() - t} ms)`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const sorted = Object.fromEntries(Object.entries(out.responses).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(import.meta.dirname, 'compiler-recorded.json'), `${JSON.stringify({ ...out, responses: sorted }, null, 2)}\n`);
log(`wrote compiler-recorded.json (${Object.keys(sorted).length} responses)`);
