/**
 * The guest review token from the page URL (#122). New links carry it in the fragment
 * (/bay/r#<token>), which the browser never sends to a server. Links minted before #122 put it
 * in the path (/bay/r/<token>); those still open.
 */
export function readReviewToken(pathname: string, hash: string): string {
  const fromHash = hash.replace(/^#/, '').trim();
  if (fromHash) return fromHash;
  return pathname.match(/\/r\/([^/]+)\/?$/)?.[1] ?? '';
}

/** The fragment-form URL path for a legacy /r/<token> path, or null when already fragment-form. */
export function fragmentFormPath(pathname: string, hash: string, token: string): string | null {
  if (!token || hash) return null;
  return `${pathname.replace(/\/r\/[^/]+\/?$/, '/r')}#${token}`;
}
