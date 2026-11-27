import type { FastifyInstance } from 'fastify';
import {
  bastionAnswerLibraryQuerySchema,
  bastionAnswerLibraryUpdateSchema,
  bastionDraftAnswerSchema,
  bastionQuestionnaireApproveSchema,
  bastionQuestionnaireAutofillSchema,
  bastionQuestionnaireCreateSchema,
  bastionQuestionnaireExportQuerySchema,
  bastionQuestionnaireItemListQuerySchema,
  bastionQuestionnaireItemReviewSchema,
  bastionQuestionnaireListQuerySchema,
  bastionQuestionnaireUpdateSchema,
} from '@bigbluebam/shared';
import { rejectWhenImpersonating, requireAuth, requireSession } from '../plugins/auth.js';
import { askerUserIdOf } from '../lib/asker.js';
import { downloadHeaders } from '../lib/download.js';
import { handled, idParam, notFound, validationError, viewerOf } from '../lib/http.js';
import { autofillDeps, questionnaireDeps } from '../services/questionnaire-runtime.js';
import { draftOneAnswer } from '../services/questionnaire-autofill.service.js';
import * as questionnaires from '../services/questionnaires.service.js';

// Spec 5.1 rows 72-83 (M8): security-questionnaire autofill and the answer library (spec 2.7).
// Approve is a vouching route (spec 2.8, #136): session-only, never impersonated, a human; it has
// no MCP tool. The export is a byte response (no tool). Everything else an agent may do through
// an API key, under the same permissions (decision #196).
export default async function questionnaireRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);
  const deps = () => questionnaireDeps(fastify.log, fastify.redis);
  // asker_user_id (#217) is read by requireAskerCan and askerOf, never by the strict query schemas.
  // It is taken out of the query only on routes that honor it (#274); anywhere else it stays in and
  // the strict schema refuses it, so a request to narrow can never silently come back wider.
  const query = (request: { query: unknown }, honorsAsker: boolean) => {
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => !(honorsAsker && k === 'asker_user_id') && v !== undefined && v !== ''));
  };
  const askerOf = (request: { query: unknown }) => {
    const a = askerUserIdOf(request.query);
    return a === 'invalid' ? null : a;
  };

  // Row 72. Titles, requesters (customer names) and deal links are customer data: with
  // asker_user_id the asker must hold questionnaire.read too (#274, as rows 74 and 77).
  fastify.get(
    '/questionnaires',
    { preHandler: [requireAuth, can('bastion.questionnaire.read'), fastify.requireAskerCan('bastion.questionnaire.read')] },
    async (request, reply) => {
      const parsed = bastionQuestionnaireListQuerySchema.safeParse(query(request, true));
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => questionnaires.listQuestionnaires(deps(), viewerOf(request), parsed.data));
    },
  );

  // Row 73: from a Bin file (xlsx or csv) or pasted rows. The body is JSON (the file is already in Bin).
  fastify.post('/questionnaires', { preHandler: [requireAuth, can('bastion.questionnaire.write')], bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const parsed = bastionQuestionnaireCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const out = await questionnaires.createQuestionnaire(deps(), viewerOf(request), parsed.data);
      reply.status(201);
      return out;
    });
  });

  // Row 74. Question text is customer data: with asker_user_id the asker must hold questionnaire.read too.
  fastify.get(
    '/questionnaires/:id',
    { preHandler: [requireAuth, can('bastion.questionnaire.read'), fastify.requireAskerCan('bastion.questionnaire.read')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      return handled(request, reply, () => questionnaires.getQuestionnaire(deps(), viewerOf(request), id));
    },
  );

  // Row 75.
  fastify.patch('/questionnaires/:id', { preHandler: [requireAuth, can('bastion.questionnaire.write')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionQuestionnaireUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => questionnaires.updateQuestionnaire(deps(), viewerOf(request), id, parsed.data));
  });

  // Row 76 (202): the worker drafts every row (spec 7.3 time estimates on the page).
  fastify.post('/questionnaires/:id/autofill', { preHandler: [requireAuth, can('bastion.questionnaire.write')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionQuestionnaireAutofillSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const out = await questionnaires.startAutofill(deps(), viewerOf(request), id, parsed.data);
      reply.status(202);
      return out;
    });
  });

  // Row 77. Citations pass can_access for the reader, and for the asker too when one is named (#217).
  fastify.get(
    '/questionnaires/:id/items',
    { preHandler: [requireAuth, can('bastion.questionnaire.read'), fastify.requireAskerCan('bastion.questionnaire.read')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionQuestionnaireItemListQuerySchema.safeParse(query(request, true));
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => questionnaires.listItems(deps(), viewerOf(request), id, parsed.data, askerOf(request)));
    },
  );

  // Row 78.
  fastify.patch('/questionnaire-items/:id', { preHandler: [requireAuth, can('bastion.questionnaire.write')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionQuestionnaireItemReviewSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => questionnaires.reviewItem(deps(), viewerOf(request), id, parsed.data));
  });

  // Row 79: Approve. Vouching: session, not impersonated, a human (assertHumanDecider in the service).
  fastify.post(
    '/questionnaires/:id/approve',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.questionnaire.approve')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionQuestionnaireApproveSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => questionnaires.approveQuestionnaire(deps(), viewerOf(request), id));
    },
  );

  // Row 80: the answered questionnaire in its own layout (byte response; formula-neutralized).
  fastify.get('/questionnaires/:id/export', { preHandler: [requireAuth, can('bastion.questionnaire.export')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionQuestionnaireExportQuerySchema.safeParse(query(request, false));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, async () => {
      const out = await questionnaires.exportQuestionnaire(deps(), viewerOf(request), id, parsed.data.format);
      reply.headers(downloadHeaders({ contentType: out.contentType, filename: out.filename, size: out.body.length }));
      return reply.send(out.body);
    });
  });

  // Row 81: draft one answer now (nothing saved). The draft quotes the org's controls and approved
  // answers, so with asker_user_id the asker must hold questionnaire.write and every citation must
  // pass can_access for them too (#274).
  fastify.post(
    '/answers/draft',
    { preHandler: [requireAuth, can('bastion.questionnaire.write'), fastify.requireAskerCan('bastion.questionnaire.write')] },
    async (request, reply) => {
      const parsed = bastionDraftAnswerSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => draftOneAnswer(autofillDeps(fastify.log, fastify.redis), viewerOf(request), parsed.data, undefined, askerOf(request)));
    },
  );

  // Row 82.
  fastify.get(
    '/answer-library',
    { preHandler: [requireAuth, can('bastion.answer_library.read'), fastify.requireAskerCan('bastion.answer_library.read')] },
    async (request, reply) => {
      const parsed = bastionAnswerLibraryQuerySchema.safeParse(query(request, true));
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => questionnaires.listAnswerLibrary(deps(), viewerOf(request), parsed.data, askerOf(request)));
    },
  );

  // Row 83.
  fastify.patch('/answer-library/:id', { preHandler: [requireAuth, can('bastion.answer_library.write')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionAnswerLibraryUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => questionnaires.updateAnswerLibrary(deps(), viewerOf(request), id, parsed.data));
  });
}
