import { describe, expect, it } from 'vitest';
import { nonBamToolPatterns } from '../src/lib/agent-tool-patterns';

// #367: a project-restricted agent can only use Bam tools; the form warns about the rest.
describe('nonBamToolPatterns', () => {
  it('flags other-app patterns and a bare wildcard', () => {
    expect(nonBamToolPatterns('banter_*\nbond_get_*\nget_me\n*\nhelpdesk*')).toEqual([
      'banter_*',
      'bond_get_*',
      '*',
      'helpdesk*',
    ]);
  });

  it('leaves Bam tool patterns alone', () => {
    expect(nonBamToolPatterns('create_task\nlist_*\nget_me\n\n  ')).toEqual([]);
  });

  it('does not mistake a Bam tool that merely starts with an app word', () => {
    expect(nonBamToolPatterns('billing_report\nboards_list')).toEqual([]);
  });
});
