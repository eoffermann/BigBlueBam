import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checkUrl, safeFetch } from '@bigbluebam/egress-guard';
import { requireAuth } from '../plugins/auth.js';

const querySchema = z.object({
  url: z.string().url().max(2048),
});

/**
 * Link preview endpoint. Fetches og:title, og:description, og:image from
 * an external URL and returns them as structured data. Results are cached
 * in-memory for 10 minutes to avoid repeated fetches.
 */
export default async function linkPreviewRoutes(fastify: FastifyInstance) {
  // Simple in-memory cache with TTL
  const cache = new Map<string, { data: unknown; expires: number }>();
  const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  // GET /v1/link-preview?url=...
  fastify.get(
    '/v1/link-preview',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { url } = querySchema.parse(request.query);

      // Refuse internal targets up front. This used to be a three-name denylist
      // (localhost, 127.0.0.1, 0.0.0.0) that let 127.1, [::1], every RFC1918
      // address, 169.254.169.254 and any DNS name pointing at them through.
      // safeFetch below repeats the check on every redirect hop and pins the
      // connection to the vetted address.
      const check = await checkUrl(url);
      if (!check.safe) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: check.reason === 'Invalid URL' ? 'Invalid URL' : 'Cannot preview internal URLs',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Check cache
      const cached = cache.get(url);
      if (cached && cached.expires > Date.now()) {
        return reply.send(cached.data);
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await safeFetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'BigBlueBam-LinkPreview/1.0 (compatible; +https://bigbluebam.com)',
            'Accept': 'text/html',
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          return reply.send({ data: null });
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) {
          return reply.send({ data: null });
        }

        // Only read the first 64KB to extract meta tags
        const reader = response.body?.getReader();
        if (!reader) {
          return reply.send({ data: null });
        }

        let html = '';
        const decoder = new TextDecoder();
        let bytesRead = 0;
        const MAX_BYTES = 64 * 1024;

        while (bytesRead < MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          html += decoder.decode(value, { stream: true });
          bytesRead += value.length;
          // Stop early if we've passed </head>
          if (html.includes('</head>')) break;
        }

        reader.cancel().catch(() => {});

        // Parse OG tags from the HTML
        const preview = extractOgTags(html, url);

        const result = { data: preview };

        // Cache the result
        cache.set(url, { data: result, expires: Date.now() + CACHE_TTL_MS });

        // Evict stale entries periodically
        if (cache.size > 500) {
          const now = Date.now();
          for (const [key, val] of cache) {
            if (val.expires < now) cache.delete(key);
          }
        }

        return reply.send(result);
      } catch (err) {
        fastify.log.debug({ err, url }, 'Link preview fetch failed');
        return reply.send({ data: null });
      }
    },
  );
}

interface OgPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
  favicon?: string;
}

function extractOgTags(html: string, pageUrl: string): OgPreview | null {
  const preview: OgPreview = { url: pageUrl };

  // Extract og:title
  const ogTitle = extractMeta(html, 'og:title') || extractMeta(html, 'twitter:title');
  // Fall back to <title> tag
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  preview.title = ogTitle || titleTag?.trim();

  if (!preview.title) return null;

  // Extract og:description
  preview.description =
    extractMeta(html, 'og:description') ||
    extractMeta(html, 'twitter:description') ||
    extractMetaName(html, 'description');

  // Extract og:image
  preview.image =
    extractMeta(html, 'og:image') || extractMeta(html, 'twitter:image');

  // Resolve relative image URLs
  if (preview.image && !preview.image.startsWith('http')) {
    try {
      preview.image = new URL(preview.image, pageUrl).href;
    } catch {
      preview.image = undefined;
    }
  }

  // Extract og:site_name
  preview.site_name = extractMeta(html, 'og:site_name');

  // Extract favicon
  const faviconMatch = html.match(
    /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i,
  );
  if (faviconMatch) {
    try {
      preview.favicon = new URL(faviconMatch[1]!, pageUrl).href;
    } catch {
      // ignore
    }
  }
  if (!preview.favicon) {
    try {
      preview.favicon = new URL('/favicon.ico', pageUrl).href;
    } catch {
      // ignore
    }
  }

  return preview;
}

function extractMeta(html: string, property: string): string | undefined {
  // Match <meta property="og:..." content="...">
  const re = new RegExp(
    `<meta[^>]+property=["']${escapeRegExp(property)}["'][^>]+content=["']([^"']+)["']`,
    'i',
  );
  const match = html.match(re);
  if (match) return decodeHtmlEntities(match[1]!);

  // Also try content before property (some sites reverse attribute order)
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRegExp(property)}["']`,
    'i',
  );
  const match2 = html.match(re2);
  if (match2) return decodeHtmlEntities(match2[1]!);

  return undefined;
}

function extractMetaName(html: string, name: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+name=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`,
    'i',
  );
  const match = html.match(re);
  if (match) return decodeHtmlEntities(match[1]!);

  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escapeRegExp(name)}["']`,
    'i',
  );
  const match2 = html.match(re2);
  if (match2) return decodeHtmlEntities(match2[1]!);

  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}
