// Plain-language sentences shared by more than one Bastion page (#254). Bastion is run by
// non-specialists: no "(s)" plurals, no internal words like "cited" or "the compiler".

/**
 * Why some items behind a result are missing for this reader, e.g. "1 item behind this result is
 * hidden because you don't have access to it." Used on Control detail (evidence) and the Review
 * queue (drafted fixes). Null when nothing is hidden.
 */
export function hiddenItemsSentence(count: number | null | undefined): string | null {
  const n = Number(count ?? 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n === 1
    ? "1 item behind this result is hidden because you don't have access to it."
    : `${n} items behind this result are hidden because you don't have access to them.`;
}
