// Turn what a person pastes into the Evidence locker's "file from Bin" field into a Bin asset id
// (#219). People copy the address bar from Bin (https://host/bin/assets/<id>), so a link is the
// normal input; a bare id still works. Anything else is refused with plain words, never a schema
// message about UUIDs.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BARE = new RegExp(`^${UUID.source}$`, 'i');

export const NOT_A_BIN_LINK = "That doesn't look like a Bin file link. Open the file in Bin, copy the address from your browser, and paste it here.";

/** The asset id in a pasted Bin link or bare id, or null when there is none. */
export function binAssetIdFrom(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (BARE.test(text)) return text.toLowerCase();
  let url: URL;
  try {
    url = new URL(text, 'http://bin.invalid');
  } catch {
    return null;
  }
  // /bin/assets/<id> (the asset page); the app may sit under a prefix, so match the tail.
  const path = /\/bin\/assets\/([^/?#]+)\/?$/i.exec(url.pathname);
  if (path && BARE.test(decodeURIComponent(path[1] ?? ''))) return decodeURIComponent(path[1] ?? '').toLowerCase();
  // A Bin link that names the asset in its query (?asset=<id> or ?asset_id=<id>).
  if (/\/bin(\/|$)/i.test(url.pathname)) {
    for (const key of ['asset', 'asset_id', 'id']) {
      const v = url.searchParams.get(key);
      if (v && BARE.test(v)) return v.toLowerCase();
    }
  }
  return null;
}
