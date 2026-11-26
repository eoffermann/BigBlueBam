/**
 * Banter message-attachment downloads (issue #142).
 *
 * Attachments used to be handed out as `/files/banter/uploads/...` URLs served by
 * the api's /files proxy to ANY signed-in user of ANY org, with no revocation:
 * someone removed from a private channel kept every link. They are now served by
 * GET /v1/channels/:id/attachments/:attachmentId, which runs the same channel
 * read check as the message list (requireChannelMember), so access follows
 * channel membership.
 */

/** The authorized URL the API hands out for an attachment. */
export function attachmentDownloadUrl(channelId: string, attachmentId: string): string {
  return `/banter/api/v1/channels/${channelId}/attachments/${attachmentId}`;
}

/** The prefix every key written by POST /v1/files/upload and presigned-upload uses. */
export const BANTER_UPLOAD_PREFIX = 'banter/uploads/';

/**
 * Whether a stored attachment key may be served for a caller in `orgId`. Keys
 * come from our own uploads (banter/uploads/<uuid>-<name>) or from the Slack
 * importer (attachments/<org-id>/slack-imports/...). Anything else (for example
 * a key some client attached that points at another app's object) is refused.
 */
export function isServableAttachmentKey(key: string, orgId: string): boolean {
  if (!key || key.startsWith('/') || key.includes('\\')) return false;
  if (key.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  if (key.startsWith(BANTER_UPLOAD_PREFIX)) return true;
  return key.startsWith(`attachments/${orgId}/slack-imports/`);
}

// Types a browser may render inline from our origin. Everything else (notably
// anything HTML- or script-shaped a Slack import may have brought in) downloads.
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export function dispositionFor(contentType: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'attachment';
  const inline =
    INLINE_TYPES.has(contentType) || contentType.startsWith('video/') || contentType.startsWith('audio/');
  return `${inline ? 'inline' : 'attachment'}; filename="${safe}"`;
}
