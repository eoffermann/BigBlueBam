import { describe, it, expect } from 'vitest';
import { EgressBlockedError } from '@bigbluebam/egress-guard';
import { llmFetch } from '../src/lib/llm-fetch.js';

// #328: the org-admin-controlled LLM api_endpoint used to be fetched with a
// bare fetch() behind a literal-IP-only validator. Every LLM call now goes
// through llmFetch (egress-guard safeFetch), which refuses these before any
// connection is attempted.
describe('llmFetch SSRF guard', () => {
  it.each([
    'http://169.254.169.254/v1/messages',
    'http://100.100.100.200/v1/chat/completions',
    'http://[::ffff:a9fe:a9fe]/v1/messages',
    'http://localhost:11434/v1/chat/completions',
    'file:///etc/passwd',
  ])('refuses %s', async (url) => {
    await expect(llmFetch(url, { method: 'POST' })).rejects.toBeInstanceOf(EgressBlockedError);
  });
});
