import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

// The canonical client snippets (Blip Design §18.1 C#, §18.2 Python, §4.3 curl).
// This design document is the source of truth; these strings reproduce it. The
// ingest URL and token are interpolated at the two call sites: the key-creation
// panel (live token) and the Client setup page (placeholder token).

export function csharpSnippet(ingestUrl: string, token: string): string {
  return `using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace BigBlueBam.Blip
{
    /// <summary>
    /// Minimal Blip telemetry client. Sends JSON reports to a Blip ingest
    /// endpoint. Every report must contain a non-empty <c>report_type</c>; all
    /// other fields are free-form and discovered server-side.
    /// </summary>
    public sealed class BlipClient : IDisposable
    {
        private readonly HttpClient _http;
        private readonly Uri _ingestUri;

        public BlipClient(string ingestUrl, string ingestKey)
        {
            _ingestUri = new Uri(ingestUrl);
            _http = new HttpClient();
            // The key travels on every request; never logged client-side.
            _http.DefaultRequestHeaders.Add("X-Blip-Key", ingestKey);
        }

        public async Task<bool> ReportAsync(string reportType, IDictionary<string, object> fields = null)
        {
            var payload = fields is null
                ? new Dictionary<string, object>()
                : new Dictionary<string, object>(fields);
            payload["report_type"] = reportType;

            var json = JsonSerializer.Serialize(payload);
            using var content = new StringContent(json, Encoding.UTF8, "application/json");

            // 202 == accepted (queued + tailed), not durably stored.
            var resp = await _http.PostAsync(_ingestUri, content).ConfigureAwait(false);
            return resp.StatusCode == System.Net.HttpStatusCode.Accepted;
        }

        public void Dispose() => _http.Dispose();
    }
}

// Wire it up:
// var blip = new BlipClient("${ingestUrl}", "${token}");
// await blip.ReportAsync("fn_timing", new Dictionary<string, object> {
//     ["fn"] = "decodeFrame", ["elapsed_ms"] = 12.4, ["level"] = "debug",
// });`;
}

export function pythonSnippet(ingestUrl: string, token: string): string {
  return `"""Minimal Blip telemetry client.

Sends JSON reports to a Blip ingest endpoint. The only mandatory field in a
report is 'report_type'; everything else is free-form and discovered
server-side.
"""

from __future__ import annotations

from typing import Any

import requests


class BlipClient:
    def __init__(self, ingest_url: str, ingest_key: str, timeout: float = 5.0) -> None:
        self._url = ingest_url
        self._timeout = timeout
        self._session = requests.Session()
        # The key travels on every request; it is never logged.
        self._session.headers["X-Blip-Key"] = ingest_key

    def report(self, report_type: str, **fields: Any) -> bool:
        payload = dict(fields)
        payload["report_type"] = report_type  # the one mandatory key
        resp = self._session.post(self._url, json=payload, timeout=self._timeout)
        # 202 == accepted (queued + tailed), not durably stored.
        return resp.status_code == 202

    def report_batch(self, reports: list[dict[str, Any]]) -> bool:
        resp = self._session.post(self._url, json=reports, timeout=self._timeout)
        return resp.status_code == 202


# Wire it up:
blip = BlipClient("${ingestUrl}", "${token}")
blip.report("fn_timing", fn="decodeFrame", elapsed_ms=12.4, level="debug")`;
}

export function curlSnippet(ingestUrl: string, token: string): string {
  return `curl -X POST "${ingestUrl}" \\
  -H "X-Blip-Key: ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{ "report_type": "fn_timing", "fn": "decodeFrame",
        "elapsed_ms": 12.4, "level": "debug", "platform": "ios" }'

# 202 Accepted
# { "accepted": 1, "rejected": 0 }`;
}

export type SnippetLang = 'csharp' | 'python' | 'curl';

const LANG_LABEL: Record<SnippetLang, string> = {
  csharp: 'Unity / C#',
  python: 'Python',
  curl: 'curl / HTTP',
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

interface ClientSnippetsProps {
  ingestUrl: string;
  /** The minted token (key-creation) or a placeholder (Client setup page). */
  token: string;
}

/**
 * Tabbed C#/Python/curl snippet block with per-tab copy. There is no suite-wide
 * language-tabs component, so this is Blip-local; it follows RevealOnceSecret's
 * mono-code + copy idiom (§18.3).
 */
export function ClientSnippets({ ingestUrl, token }: ClientSnippetsProps) {
  const [lang, setLang] = useState<SnippetLang>('csharp');
  const code =
    lang === 'csharp'
      ? csharpSnippet(ingestUrl, token)
      : lang === 'python'
        ? pythonSnippet(ingestUrl, token)
        : curlSnippet(ingestUrl, token);

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 px-2 py-1.5">
        <div className="flex items-center gap-1">
          {(Object.keys(LANG_LABEL) as SnippetLang[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={
                lang === l
                  ? 'rounded-md bg-white dark:bg-zinc-900 px-3 py-1 text-xs font-medium text-zinc-900 dark:text-zinc-100 shadow-sm'
                  : 'rounded-md px-3 py-1 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }
            >
              {LANG_LABEL[l]}
            </button>
          ))}
        </div>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto bg-zinc-950 text-zinc-100 p-4 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}
