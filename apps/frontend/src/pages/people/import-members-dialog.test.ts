import { describe, it, expect } from 'vitest';
import { parseImportMembers } from './import-members-dialog';
import { parseCsv } from '@/lib/csv';

describe('parseCsv', () => {
  it('handles quoted fields, embedded commas, doubled quotes, and CRLF', () => {
    const text = 'a,b,c\r\n"x,1","he said ""hi""",z\r\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x,1', 'he said "hi"', 'z'],
    ]);
  });
  it('strips a leading BOM and tolerates no trailing newline', () => {
    expect(parseCsv('﻿email\njane@acme.com')).toEqual([['email'], ['jane@acme.com']]);
  });
});

describe('parseImportMembers — Slack', () => {
  const slack =
    'username,email,status,billing-active,has-2fa,has-sso,userid,fullname,displayname,expiration-timestamp\n' +
    'jane,jane@acme.com,Member,true,true,false,U1,Jane Doe,jdoe,\n' +
    'bob,bob@acme.com,Deactivated,false,false,false,U2,Bob Stone,bstone,\n' +
    'beep,beep@acme.com,Bot,false,false,false,U3,Beep Bot,beep,\n' +
    'carol,carol@acme.com,Admin,true,true,false,U4,Carol Ng,cng,\n';

  it('maps email + fullname and skips deactivated members and bots', () => {
    const { rows, skipped } = parseImportMembers(slack, 'slack');
    expect(rows).toEqual([
      { email: 'jane@acme.com', display_name: 'Jane Doe' },
      { email: 'carol@acme.com', display_name: 'Carol Ng' },
    ]);
    expect(skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Deactivated/), expect.stringMatching(/Bot/)]),
    );
  });
});

describe('parseImportMembers — Google Workspace', () => {
  const google =
    'First Name [Required],Last Name [Required],Email Address [Required],New Status [UPLOAD ONLY]\n' +
    'Jane,Doe,jane@acme.com,active\n' +
    'Sam,Gone,sam@acme.com,suspended\n';

  it('joins first+last into a name, matches the bracketed email header, and skips suspended', () => {
    const { rows, skipped } = parseImportMembers(google, 'google');
    expect(rows).toEqual([{ email: 'jane@acme.com', display_name: 'Jane Doe' }]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/suspend/i);
  });
});

describe('parseImportMembers — generic', () => {
  it('auto-detects the email + name columns regardless of order', () => {
    const csv = 'Full Name,Email\nJane Doe,jane@acme.com\n,no-at-symbol\n';
    const { rows, skipped } = parseImportMembers(csv, 'generic');
    expect(rows).toEqual([{ email: 'jane@acme.com', display_name: 'Jane Doe' }]);
    // second row has no valid email → skipped
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/no email/);
  });

  it('drops in-file duplicate emails (case-insensitive)', () => {
    const csv = 'email,name\njane@acme.com,Jane\nJANE@acme.com,Jane Again\n';
    const { rows, skipped } = parseImportMembers(csv, 'generic');
    expect(rows).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/duplicate/);
  });

  it('errors clearly when there is no email column', () => {
    const { error } = parseImportMembers('name,team\nJane,Eng\n', 'generic');
    expect(error).toMatch(/email column/i);
  });
});
