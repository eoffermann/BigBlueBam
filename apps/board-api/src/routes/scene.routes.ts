import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireBoardAccess, requireBoardEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { loadScene, saveScene, type SceneData } from '../ws/persistence.js';

const sceneBodySchema = z.object({
  elements: z.array(z.unknown()),
  appState: z.record(z.unknown()).optional(),
  files: z.record(z.unknown()).optional(),
});

export default async function sceneRoutes(fastify: FastifyInstance) {
  // GET /boards/:id/scene — Load saved Excalidraw scene
  fastify.get<{ Params: { id: string } }>(
    '/boards/:id/scene',
    { preHandler: [requireAuth, requireBoardAccess(), shadowOnly('board.board_scene.get')] },
    async (request, reply) => {
      const board = (request as any).board;
      const scene = await loadScene(board.id, request.user!.org_id);

      if (!scene) {
        return reply.send({
          data: { elements: [], appState: {}, files: {} },
        });
      }

      return reply.send({ data: scene });
    },
  );

  // PUT /boards/:id/scene — Full scene save
  fastify.put<{ Params: { id: string } }>(
    '/boards/:id/scene',
    {
      preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board_scene.update'), requireScope('read_write')],
    },
    async (request, reply) => {
      const board = (request as any).board;
      const body = sceneBodySchema.parse(request.body);

      const sceneData: SceneData = {
        elements: body.elements,
        appState: body.appState ?? {},
        files: body.files ?? {},
      };

      // saveScene also triggers element snapshot sync internally
      await saveScene(board.id, request.user!.org_id, sceneData);

      return reply.send({ data: { saved: true } });
    },
  );

  // POST /boards/:id/scene/beacon — fire-and-forget flush for
  // navigator.sendBeacon. Browsers limit beacon size to ~64KB and
  // require Content-Type 'application/json' (not application/json;
  // charset=utf-8). The endpoint is intentionally identical in semantics
  // to PUT /scene but uses POST so beacon-style fetch has a destination.
  // Critically: it persists DIRECTLY to boards.yjs_state — we don't
  // route through the Redis dirty hash because the user is leaving the
  // page and we want the durable write to land before the tab dies, not
  // a Redis intermediate that depends on the 5s flush timer firing.
  fastify.post<{ Params: { id: string } }>(
    '/boards/:id/scene/beacon',
    {
      preHandler: [requireAuth, requireBoardEditAccess(), shadowOnly('board.board_scene_beacon.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const board = (request as any).board;
      const body = sceneBodySchema.parse(request.body);

      const sceneData: SceneData = {
        elements: body.elements,
        appState: body.appState ?? {},
        files: body.files ?? {},
      };

      await saveScene(board.id, request.user!.org_id, sceneData);
      return reply.send({ data: { saved: true } });
    },
  );
}
