import { parseDocument, Document } from 'yaml';
import type { DecodeResult } from '../types.js';

/**
 * YAML codec. Edits must go through the Document/CST API to preserve comments,
 * key order, and block-vs-flow style across a round trip (Bin master §10.6).
 * decode keeps the parsed Document on the result so the commit path can edit
 * through it; `data` is the plain JS projection used for shape + inference.
 */
export interface YamlDecodeResult extends DecodeResult {
  /** The parsed yaml Document, retained for comment/order-preserving edits. */
  doc: Document.Parsed;
}

export function decodeYaml(text: string): YamlDecodeResult {
  const doc = parseDocument(text);
  return { format: 'yaml', data: doc.toJS(), dialect: { format: 'yaml' }, doc };
}

/**
 * Serialize back to YAML. When the original Document is supplied, edits should
 * have been applied to it (preserving comments/order); we stringify that. When
 * only a plain value is supplied (e.g. a freshly-built value), stringify it.
 */
export function encodeYaml(data: unknown, doc?: Document.Parsed): string {
  if (doc) return String(doc);
  // Fall back to a fresh Document so output is still valid YAML.
  return String(new Document(data));
}

/** Detect whether a YAML document uses anchors/aliases/merge keys, which gate the
 *  safe-subset edit path (master §10.6). */
export function yamlHasAnchors(text: string): boolean {
  // Anchors (&name), aliases (*name), or merge keys (<<:). Conservative regex.
  return /(^|\s)[&*][A-Za-z0-9_-]+/.test(text) || /(^|\s)<<\s*:/.test(text);
}
