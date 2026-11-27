import { afterEach, describe, expect, it, vi } from 'vitest';
import { bondInternalContactUpsertSchema, helpdeskInternalTicketCreateSchema } from '@bigbluebam/shared';

// #305: Blank routing actions used to POST bond-api's session-authenticated /v1/contacts and
// helpdesk-api's /v1/tickets with the internal secret, so every routed contact and ticket failed.
// They now call the owning apps' internal routes with the shared contracts.

const { SECRET } = vi.hoisted(() => ({ SECRET: 's'.repeat(40) }));
vi.mock('../src/env.js', () => ({
  env: {
    INTERNAL_SERVICE_SECRET: SECRET,
    BOND_API_INTERNAL_URL: 'http://bond-api:4009',
    HELPDESK_API_URL: 'http://helpdesk-api:4001',
  },
}));

import { processRoutingRules } from '../src/services/routing.service.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000b1';
const ctx = { orgId: ORG, submissionId: 'sub-1', formOwnerUserId: OWNER, submitterEmail: null };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

afterEach(() => vi.restoreAllMocks());

describe('processRoutingRules', () => {
  it('creates the Bond contact and the Helpdesk ticket through the internal routes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 201 }));
    await processRoutingRules(
      {
        rules: [
          {
            condition: { field: 'interest', op: 'equals', value: 'sales' },
            action: { type: 'bond_contact', field_map: { email: 'email', first_name: 'name' } },
          },
          {
            condition: { field: 'type', op: 'equals', value: 'support' },
            action: { type: 'helpdesk_ticket', field_map: { subject: 'subject', body: 'details', email: 'email' } },
          },
        ],
      },
      { interest: 'sales', type: 'support', email: 'mary.ann@island.example', name: 'Mary Ann', subject: 'Hut leak', details: 'Roof leaks in the rain' },
      ctx,
      logger,
    );

    expect(logger.error).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [bondUrl, bondInit] = fetchSpy.mock.calls[0]!;
    expect(String(bondUrl)).toBe('http://bond-api:4009/v1/internal/contacts');
    expect((bondInit!.headers as Record<string, string>)['X-Internal-Service-Secret']).toBe(SECRET);
    const bondBody = bondInternalContactUpsertSchema.parse(JSON.parse(String(bondInit!.body)));
    expect(bondBody).toMatchObject({ org_id: ORG, acting_user_id: OWNER, email: 'mary.ann@island.example', first_name: 'Mary Ann' });

    const [hdUrl, hdInit] = fetchSpy.mock.calls[1]!;
    expect(String(hdUrl)).toBe('http://helpdesk-api:4001/helpdesk/internal/tickets');
    const hdBody = helpdeskInternalTicketCreateSchema.parse(JSON.parse(String(hdInit!.body)));
    expect(hdBody).toMatchObject({
      org_id: ORG,
      requester_email: 'mary.ann@island.example',
      subject: 'Hut leak',
      description: 'Roof leaks in the rain',
    });
  });

  it('falls back to the submitter email and skips (not fails) when there is no email at all', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 201 }));
    const config = { rules: [{ condition: { field: 'x', op: 'always' }, action: { type: 'bond_contact', field_map: {} } }] };
    await processRoutingRules(config, {}, { ...ctx, submitterEmail: 'ginger@island.example' }, logger);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body)).email).toBe('ginger@island.example');

    fetchSpy.mockClear();
    await processRoutingRules(config, {}, ctx, logger);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('reports a refused internal call as a failed action', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":{}}', { status: 401 }));
    const errors = vi.fn();
    await processRoutingRules(
      { rules: [{ condition: { field: 'x', op: 'always' }, action: { type: 'bond_contact', field_map: { email: 'e' } } }] },
      { e: 'skipper@island.example' },
      ctx,
      { ...logger, error: errors },
    );
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
