// Programmatic Slack workspace export fixture (~3 channels, ~50 messages,
// some threads + reactions, 2 file refs, pins). Built with JSZip at test
// time rather than checked in as a binary so reviewers can see exactly
// what's in it.
//
// Shape mirrors a real Slack export per docs/plans/slack-import-design.md §2.

import JSZip from 'jszip';

export interface MiniWorkspace {
  zip: Buffer;
  workspaceName: string;
  channels: Array<{ id: string; name: string; created_by: string }>;
  users: Array<{ id: string; name: string; email?: string }>;
  totalMessages: number;
}

export async function buildMiniWorkspaceZip(): Promise<MiniWorkspace> {
  const users = [
    { id: 'U001', name: 'alice', real_name: 'Alice Admin', email: 'alice@acme.example' },
    { id: 'U002', name: 'bob',   real_name: 'Bob Builder', email: 'bob@acme.example' },
    { id: 'U003', name: 'carol', real_name: 'Carol Coder', email: undefined },
    { id: 'U004', name: 'dave',  real_name: 'Dave Designer', email: undefined },
  ];

  const channels = [
    { id: 'C001', name: 'general',     created_by: 'U001', members: ['U001','U002','U003','U004'] },
    { id: 'C002', name: 'random',      created_by: 'U002', members: ['U001','U002','U004'] },
    { id: 'C003', name: 'engineering', created_by: 'U003', members: ['U001','U003','U004'] },
  ];

  const zip = new JSZip();

  // ── users.json
  zip.file('users.json', JSON.stringify(users.map((u) => ({
    id: u.id,
    name: u.name,
    real_name: u.real_name,
    profile: {
      display_name: u.name,
      real_name: u.real_name,
      email: u.email ?? '',
    },
    deleted: false,
    is_bot: false,
  })), null, 2));

  // ── channels.json (3 channels, includes pins on engineering)
  zip.file('channels.json', JSON.stringify(channels.map((c) => ({
    id: c.id,
    name: c.name,
    created: 1704067200,
    creator: c.created_by,
    is_archived: false,
    members: c.members,
    topic:    { value: `${c.name} topic`,   creator: c.created_by, last_set: 1704067200 },
    purpose:  { value: `${c.name} purpose`, creator: c.created_by, last_set: 1704067200 },
    // Pin the engineering channel's first message. The ts must match the
    // ts emitted in the day-file loop below (channel-index-based offset).
    pins: c.name === 'engineering' ? [{ id: '1704367200.002000', type: 'C', user: 'U001', created: 1704367200 }] : [],
  })), null, 2));

  // ── groups.json (empty)
  zip.file('groups.json', '[]');
  zip.file('dms.json', '[]');
  zip.file('mpims.json', '[]');

  // ── per-channel message files
  let totalMessages = 0;
  const baseTs = 1704067200; // Jan 1 2024 UTC
  for (let cIdx = 0; cIdx < channels.length; cIdx++) {
    const c = channels[cIdx]!;
    // Per-channel ts offset uses the channel index so `random` and
    // `engineering` (both with the same member count) don't collide on the
    // (import_id, ts) idempotency key.
    const tsBucket = baseTs + (cIdx + 1) * 100_000;
    const messagesPerDay = Math.ceil(50 / 3); // ~17 each — 51 total
    const dayMessages: unknown[] = [];

    for (let i = 0; i < messagesPerDay; i++) {
      const ts = `${tsBucket + i * 60}.${String(cIdx).padStart(3, '0')}${String(i).padStart(3, '0')}`;
      const author = c.members[i % c.members.length]!;
      const baseMsg: Record<string, unknown> = {
        type: 'message',
        user: author,
        text: `Hello from ${c.name} message ${i}`,
        ts,
      };

      // Sprinkle reactions on every 5th message
      if (i % 5 === 0) {
        baseMsg.reactions = [
          { name: 'thumbsup', users: c.members.slice(0, 2), count: 2 },
        ];
      }

      // Make the 3rd message a thread parent; 4th-5th become replies.
      if (i === 2) baseMsg.thread_ts = ts;
      if (i === 3 || i === 4) {
        baseMsg.thread_ts = `${tsBucket + 2 * 60}.${String(cIdx).padStart(3, '0')}${String(2).padStart(3, '0')}`;
      }

      // Attach 2 files to 1st message of 'engineering' only.
      if (c.name === 'engineering' && i === 0) {
        baseMsg.files = [
          { id: 'F001', name: 'diagram.png', mimetype: 'image/png', size: 1024,
            url_private: 'https://files.slack.com/x.png' },
          { id: 'F002', name: 'notes.txt',   mimetype: 'text/plain', size: 256 },
        ];
      }

      dayMessages.push(baseMsg);
      totalMessages += 1;
    }

    zip.file(`${c.name}/2024-01-01.json`, JSON.stringify(dayMessages, null, 2));
  }

  // Embed one file locally so the importer's "local file" branch can be
  // exercised. Slack corporate exports use "<channel>/files/<id>/<name>"
  // or "files/<id>".
  zip.file('engineering/files/F002/notes.txt', 'These are the notes.\n');

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });

  return {
    zip: buffer,
    workspaceName: 'acme-mini',
    channels: channels.map((c) => ({ id: c.id, name: c.name, created_by: c.created_by })),
    users: users.map((u) => ({ id: u.id, name: u.name, email: u.email })),
    totalMessages,
  };
}
