import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import { requireDocumentAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';

const HTML_TEMPLATE = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 2rem; }
  h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; line-height: 1.25; }
  p { margin: 0.75em 0; }
  code { background: #f4f4f4; border-radius: 3px; padding: 0.15em 0.3em; font-size: 0.9em; }
  pre { background: #f4f4f4; border-radius: 6px; padding: 1em; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #ddd; margin: 1em 0; padding: 0.5em 1em; color: #555; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 0.5em 0.75em; text-align: left; }
  th { background: #f8f8f8; font-weight: 600; }
  a { color: #2563eb; }
  ul, ol { margin: 0.75em 0; padding-left: 1.5em; }
  li { margin: 0.25em 0; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;

export default async function exportRoutes(fastify: FastifyInstance) {
  // GET /documents/:id/export/markdown — Export as Markdown
  fastify.get<{ Params: { id: string } }>(
    '/documents/:id/export/markdown',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_export_markdown.get')] },
    async (request, reply) => {
      const doc = (request as any).document;
      const content = doc.plain_text ?? '';
      const filename = `${doc.slug}.md`;

      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(content);
    },
  );

  // GET /documents/:id/export/html — Export as styled HTML
  fastify.get<{ Params: { id: string } }>(
    '/documents/:id/export/html',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_export_html.get')] },
    async (request, reply) => {
      const doc = (request as any).document;
      const body = doc.html_snapshot ?? `<p>${(doc.plain_text ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
      const html = HTML_TEMPLATE(doc.title, body);

      return reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .send(html);
    },
  );
}
