import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';

// Pins yjsStateToPlainText, the search/viewer-freshness half of the Yjs
// flush: every debounced persistence write re-derives plain_text from the
// CRDT state so full-text search and the static viewer fallback never lag
// the collaborative content.

// The service imports the db + bolt-events modules at module scope; stub
// them so the pure function under test loads without a database.
vi.mock('../src/db/index.js', () => ({
  db: {},
  connection: { end: vi.fn() },
}));
vi.mock('../src/lib/bolt-events.js', () => ({
  publishBoltEvent: vi.fn().mockResolvedValue(undefined),
}));

const { yjsStateToPlainText } = await import('../src/services/yjs-persistence.service.js');

/** Builds an encoded Yjs state whose 'default' XmlFragment mimics the shape
 *  the Tiptap Collaboration extension writes (ProseMirror node names as
 *  XML elements, text in XmlText leaves). */
function encodeDoc(build: (fragment: Y.XmlFragment) => void): Buffer {
  const doc = new Y.Doc();
  build(doc.getXmlFragment('default'));
  const state = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return state;
}

function paragraph(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  return p;
}

describe('yjsStateToPlainText', () => {
  it('extracts text from paragraphs, one line per top-level block', () => {
    const state = encodeDoc((frag) => {
      frag.insert(0, [paragraph('First paragraph.'), paragraph('Second paragraph.')]);
    });
    expect(yjsStateToPlainText(state)).toBe('First paragraph.\nSecond paragraph.');
  });

  it('strips nested structure (headings, lists) down to text', () => {
    const state = encodeDoc((frag) => {
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', '2');
      heading.insert(0, [new Y.XmlText('Title')]);

      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      item.insert(0, [paragraph('point one')]);
      list.insert(0, [item]);

      frag.insert(0, [heading, list]);
    });
    expect(yjsStateToPlainText(state)).toBe('Title\npoint one');
  });

  it('preserves literal angle brackets and ampersands in user text', () => {
    // Yjs toString() leaves these unescaped, which is why the extractor
    // walks the tree instead of regex-stripping a serialization.
    const state = encodeDoc((frag) => {
      frag.insert(0, [paragraph('a < b && b > "c"')]);
    });
    expect(yjsStateToPlainText(state)).toBe('a < b && b > "c"');
  });

  it('reads only the text of formatted runs (marks carried as delta attributes)', () => {
    const state = encodeDoc((frag) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'plain ');
      t.insert(6, 'bold', { bold: true });
      p.insert(0, [t]);
      frag.insert(0, [p]);
    });
    expect(yjsStateToPlainText(state)).toBe('plain bold');
  });

  it('returns null for an empty fragment (legacy docs keep their plain_text)', () => {
    const state = encodeDoc(() => {});
    expect(yjsStateToPlainText(state)).toBeNull();
  });

  it('returns null on corrupt state instead of throwing', () => {
    expect(yjsStateToPlainText(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBeNull();
  });
});
