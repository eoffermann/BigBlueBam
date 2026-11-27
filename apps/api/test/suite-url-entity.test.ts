import { describe, expect, it } from 'vitest';
import { suiteUrlEntity } from '../src/lib/suite-url-entity.js';

// #300: POST /internal/can-read must judge every suite URL Bureau asks about, and deny what it
// cannot judge. It used to map only Bam task/sprint/project URLs and allow everything else.

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('suiteUrlEntity', () => {
  it('maps the entity pages that announce a presence label', () => {
    expect(suiteUrlEntity(`/bond/deals/${ID}`)).toMatchObject({ kind: 'entity', type: 'bond.deal', id: ID });
    expect(suiteUrlEntity(`/bond/contacts/${ID}`)).toMatchObject({ type: 'bond.contact' });
    expect(suiteUrlEntity(`/bill/invoices/${ID}`)).toMatchObject({ type: 'bill.invoice' });
    expect(suiteUrlEntity(`/beacon/${ID}`)).toMatchObject({ type: 'beacon.entry' });
    expect(suiteUrlEntity(`/bearing/goals/${ID}`)).toMatchObject({ type: 'bearing.goal' });
    expect(suiteUrlEntity(`/helpdesk/acme/tickets/${ID}`)).toMatchObject({ type: 'helpdesk.ticket' });
    expect(suiteUrlEntity(`https://suite.example/blueprint/d/${ID}`)).toMatchObject({ type: 'blueprint.diagram' });
  });

  it('keeps the Bam shapes, most specific first', () => {
    expect(suiteUrlEntity(`/b3/projects/${ID}/board`)).toMatchObject({ type: 'bam.project' });
    expect(suiteUrlEntity(`/b3/projects/${ID}/sprints/${ID.replace('0f', '1f')}`)).toMatchObject({ type: 'bam.sprint' });
    expect(suiteUrlEntity(`/b3/tasks/${ID}`)).toMatchObject({ type: 'bam.task' });
  });

  it('allows app homes and list pages', () => {
    expect(suiteUrlEntity('/bond')).toEqual({ kind: 'no_resource', app: 'bond' });
    expect(suiteUrlEntity('/bond/pipeline')).toEqual({ kind: 'no_resource', app: 'bond' });
    expect(suiteUrlEntity('/bill/invoices')).toEqual({ kind: 'no_resource', app: 'bill' });
  });

  it('denies what it cannot judge: unknown ids, slugs and names, and non-suite URLs', () => {
    expect(suiteUrlEntity(`/bench/dashboards/${ID}`)).toMatchObject({ kind: 'unsupported', reason: 'unsupported_resource' });
    expect(suiteUrlEntity('/beacon/acme-acquisition-plan')).toMatchObject({ kind: 'unsupported' });
    expect(suiteUrlEntity('/banter/channels/secret-merger')).toMatchObject({ kind: 'unsupported' });
    expect(suiteUrlEntity('/helpdesk/acme/tickets/42')).toMatchObject({ kind: 'unsupported' });
    expect(suiteUrlEntity('/somewhere/else')).toEqual({ kind: 'unsupported', app: null, reason: 'unsupported_app' });
  });
});
