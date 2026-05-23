import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { env } from '../env.js';

const generateSchema = z.object({
  prompt: z.string().min(1).max(2000),
  context: z.record(z.unknown()).optional(),
  project_id: z.string().uuid().optional(),
});

const explainSchema = z.object({
  automation: z.object({
    name: z.string().max(255),
    trigger_source: z.string().max(30),
    trigger_event: z.string().max(60),
    conditions: z.array(z.record(z.unknown())).optional().default([]),
    actions: z.array(z.record(z.unknown())).optional().default([]),
  }),
  project_id: z.string().uuid().optional(),
});

/**
 * Resolved LLM provider shape returned by the Bam API /llm-providers/resolve
 * endpoint. The api_key_hint is redacted -- we cannot make direct LLM calls
 * from bolt-api without the plaintext key. A future internal endpoint on the
 * Bam API (e.g. /internal/llm/chat) will proxy the actual call with the
 * decrypted key. Until then, the generate/explain routes construct best-effort
 * responses locally when no internal proxy is available.
 */
interface ResolvedProvider {
  id: string;
  provider_type: string;
  model_id: string;
  api_endpoint: string | null;
  api_key_hint: string;
  max_tokens: number | null;
  temperature: string | null;
}

/**
 * Resolves the effective LLM provider by calling the Bam API's
 * /llm-providers/resolve endpoint. Returns null if no provider is
 * configured, which should cause the route to return AI_NOT_CONFIGURED.
 */
async function resolveProvider(
  request: FastifyRequest,
  projectId?: string,
): Promise<{ provider: ResolvedProvider } | null> {
  try {
    const url = new URL('/llm-providers/resolve', env.BBB_API_INTERNAL_URL);
    if (projectId) url.searchParams.set('project_id', projectId);

    // Forward the caller's session cookie so the Bam API can authenticate
    const cookieHeader = request.headers.cookie ?? '';
    const res = await fetch(url.toString(), {
      headers: { cookie: cookieHeader },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const body = (await res.json()) as { data: ResolvedProvider | null };
    if (!body.data) return null;
    return { provider: body.data };
  } catch {
    return null;
  }
}

/**
 * Attempt to call the Bam API's internal LLM chat proxy.  This endpoint
 * lives at /internal/llm/chat and handles decryption of the provider's API
 * key, then proxies the chat completion request to the upstream LLM.
 *
 * Returns the raw LLM response text, or null if the endpoint is not
 * available (in which case we fall back to the local stub response).
 */
async function callLlmProxy(
  request: FastifyRequest,
  messages: Array<{ role: string; content: string }>,
  providerId: string,
): Promise<string | null> {
  try {
    const url = new URL('/internal/llm/chat', env.BBB_API_INTERNAL_URL);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (env.INTERNAL_SERVICE_SECRET) {
      headers['x-internal-secret'] = env.INTERNAL_SERVICE_SECRET;
    }
    // Also forward session cookie for auth fallback
    if (request.headers.cookie) {
      headers['cookie'] = request.headers.cookie;
    }

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider_id: providerId, messages }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) return null;

    const body = (await res.json()) as { data?: { content?: string } };
    return body.data?.content ?? null;
  } catch {
    return null;
  }
}

function sendAiNotConfigured(reply: FastifyReply, requestId: string) {
  return reply.status(422).send({
    error: {
      code: 'AI_NOT_CONFIGURED',
      message:
        'AI features require an LLM provider to be configured. Ask your organization administrator to set up an AI provider in Settings \u2192 AI Providers.',
      details: [],
      request_id: requestId,
    },
  });
}

export default async function aiAssistRoutes(fastify: FastifyInstance) {
  // POST /ai/generate — Generate an automation definition from a natural language prompt
  fastify.post(
    '/ai/generate',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('bolt.ai_generate.create')],
    },
    async (request, reply) => {
      const { prompt, context, project_id } = generateSchema.parse(request.body);

      // Resolve LLM provider -- if none configured, return informative error
      const resolved = await resolveProvider(request, project_id);
      if (!resolved) {
        return sendAiNotConfigured(reply, request.id);
      }

      // Attempt to call the internal LLM proxy for real generation
      const systemPrompt = [
        'You are a workflow automation assistant for BigBlueBam.',
        'Generate a valid automation definition as JSON with these fields:',
        '  name (string), description (string), trigger_source (string),',
        '  trigger_event (string), conditions (array of {sort_order, field, operator, value, logic_group}),',
        '  actions (array of {sort_order, mcp_tool, parameters, on_error}).',
        'Valid trigger sources: bam, banter, beacon, brief, helpdesk, schedule, bond, blast, board, bench, bearing, bill, book, blank.',
        'Respond ONLY with JSON, no markdown fencing.',
      ].join(' ');

      const llmResponse = await callLlmProxy(
        request,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt + (context ? `\n\nContext: ${JSON.stringify(context)}` : '') },
        ],
        resolved.provider.id,
      );

      if (llmResponse) {
        try {
          const parsed = JSON.parse(llmResponse);
          return reply.send({
            data: {
              automation: parsed,
              confidence: 0.85,
              provider: resolved.provider.provider_type,
            },
          });
        } catch {
          // LLM returned non-JSON; fall through to stub
        }
      }

      // Fallback stub when LLM proxy is unavailable
      const sample = {
        name: `Auto-generated: ${prompt.slice(0, 80)}`,
        description: `Automation generated from prompt: "${prompt}"`,
        trigger_source: 'bam',
        trigger_event: 'task.created',
        conditions: [
          {
            sort_order: 0,
            field: 'task.priority',
            operator: 'equals',
            value: 'high',
            logic_group: 'and',
          },
        ],
        actions: [
          {
            sort_order: 0,
            mcp_tool: 'banter_post_message',
            parameters: {
              channel_name: 'alerts',
              message: 'New high priority task: {{ event.task.title }}',
            },
            on_error: 'continue',
          },
        ],
      };

      return reply.send({
        data: {
          automation: sample,
          confidence: 0.7,
          message: 'LLM proxy unavailable. Returning sample automation. Configure /internal/llm/chat on the Bam API for real generation.',
        },
      });
    },
  );

  // POST /ai/explain — Explain an automation in natural language
  fastify.post(
    '/ai/explain',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('bolt.ai_explain.create')],
    },
    async (request, reply) => {
      const { automation, project_id } = explainSchema.parse(request.body);

      // Resolve LLM provider -- if none configured, return informative error
      const resolved = await resolveProvider(request, project_id);
      if (!resolved) {
        return sendAiNotConfigured(reply, request.id);
      }

      // Attempt real LLM explanation via proxy
      const llmResponse = await callLlmProxy(
        request,
        [
          {
            role: 'system',
            content: 'You are a workflow automation assistant. Explain the following automation rule in clear, concise language suitable for a non-technical user. Use plain English, avoid jargon.',
          },
          {
            role: 'user',
            content: `Explain this automation:\n${JSON.stringify(automation, null, 2)}`,
          },
        ],
        resolved.provider.id,
      );

      if (llmResponse) {
        return reply.send({
          data: {
            explanation: llmResponse,
            provider: resolved.provider.provider_type,
          },
        });
      }

      // Fallback: locally generated explanation
      const conditionCount = automation.conditions?.length ?? 0;
      const actionCount = automation.actions?.length ?? 0;

      const explanation = [
        `This automation is named "${automation.name}".`,
        `It triggers on the "${automation.trigger_event}" event from the "${automation.trigger_source}" source.`,
        conditionCount > 0
          ? `It has ${conditionCount} condition${conditionCount > 1 ? 's' : ''} that must be met before actions execute.`
          : 'It has no conditions, so it will trigger on every matching event.',
        actionCount > 0
          ? `When triggered, it will execute ${actionCount} action${actionCount > 1 ? 's' : ''} in sequence.`
          : 'It has no actions configured yet.',
      ].join(' ');

      return reply.send({
        data: {
          explanation,
          message: 'LLM proxy unavailable. Returning locally generated explanation.',
        },
      });
    },
  );
}
