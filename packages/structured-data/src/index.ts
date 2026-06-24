// @bigbluebam/structured-data — codecs, shape detection, and schema inference for
// Bin's structured-data editor. Pure and shared by bin-api, the worker, and the
// /bin/ SPA. (Bin_Master_Design_Document.md §3, §10. CRDT mapping + YAML codec
// land in the next increment.)

export * from './types.js';
export { decode, encode, detectJsonIndent } from './codecs/index.js';
export { detectShape, type ShapeResult } from './shape.js';
export { inferSchema, inferredToZod } from './inference.js';

import { decode } from './codecs/index.js';
import { detectShape } from './shape.js';
import type { Format, ParsedAsset } from './types.js';

/** Decode bytes and detect the render shape in one step, returning the dialect to
 *  replay on commit plus the record projection (rows + columns) when applicable. */
export function parseAsset(text: string, format: Format): ParsedAsset {
  const { data, dialect } = decode(text, format);
  const shaped = detectShape(data, format);
  return {
    format,
    dialect,
    shape: shaped.shape,
    data,
    rows: shaped.rows,
    columns: shaped.columns,
  };
}
