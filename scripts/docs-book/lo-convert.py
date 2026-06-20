#!/usr/bin/env python
# Convert a DOCX to PDF with LibreOffice via UNO, building the Table of Contents
# and a clean alphabetical Index along the way.
#
# Why this is not just `soffice --convert-to pdf`:
#   * Plain convert does NOT update fields, so a TOC field comes out blank.
#   * LibreOffice DROPS Word XE index marks and the INDEX field on import, so an
#     alphabetical index cannot be recovered from the docx at all.
#
# How the index is built (deterministically, no LibreOffice index object):
#   1. Populate the TOC so body pagination is final.
#   2. For each glossary term, find every whole-word occurrence and read its page
#      number off the view cursor; collect the sorted, unique page set.
#   3. Render the index ourselves as ordinary text at the Index placeholder:
#      letter groups, a bold term, then its page list. No empty or duplicate
#      entries, full control over formatting.
#   The index sits at the very end, so adding it shifts no earlier page numbers.
#
# Run with LibreOffice's bundled python:
#   "C:\Program Files\LibreOffice\program\python.exe" lo-convert.py <in.docx> <out.pdf> [terms.json]
import sys
import json
import officehelper
import unohelper
from com.sun.star.beans import PropertyValue
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
from com.sun.star.awt.FontWeight import BOLD, NORMAL

# Cap pages per term so a ubiquitous word does not produce a runaway page list.
MAX_PAGES_PER_TERM = 25
INDEX_PLACEHOLDER = "Key terms and the pages where they appear."


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def update_toc(doc):
    """Populate every content index (the TOC). Returns (entry char count, cutoff
    page). The cutoff is the last TOC page: index scanning ignores any page at or
    before it, so front matter (title page, the TOC itself) never pollutes the
    index with page refs for words that also appear as TOC section names."""
    chars = 0
    cutoff = 0
    indexes = doc.getDocumentIndexes()
    vc = doc.getCurrentController().getViewCursor()
    for i in range(indexes.getCount()):
        ix = indexes.getByIndex(i)
        try:
            if ix.supportsService("com.sun.star.text.ContentIndex"):
                try:
                    ix.CreateFromOutline = True
                except Exception:  # noqa: BLE001
                    pass
                ix.update()
                chars += len(ix.getAnchor().getString())
                try:
                    vc.gotoRange(ix.getAnchor().getEnd(), False)
                    cutoff = max(cutoff, int(vc.getPage()))
                except Exception:  # noqa: BLE001
                    pass
        except Exception as e:  # noqa: BLE001
            print("toc update err:", e)
    return chars, cutoff


def compute_term_pages(doc, terms, cutoff=0):
    """For each term, return a sorted unique list of page numbers (after `cutoff`,
    the front matter) where the term occurs (whole word, case-insensitive). Uses
    the view cursor for page lookup."""
    controller = doc.getCurrentController()
    vc = controller.getViewCursor()
    out = {}
    for term in terms:
        try:
            sd = doc.createSearchDescriptor()
            sd.setSearchString(term)
            sd.setPropertyValue("SearchWords", True)
            sd.setPropertyValue("SearchCaseSensitive", False)
            found = doc.findAll(sd)
        except Exception:  # noqa: BLE001
            continue
        pages = set()
        for i in range(found.getCount()):
            try:
                rng = found.getByIndex(i)
                vc.gotoRange(rng.getStart(), False)
                pg = int(vc.getPage())
                if pg > cutoff:  # skip title page + the TOC itself
                    pages.add(pg)
            except Exception:  # noqa: BLE001
                pass
            if len(pages) >= MAX_PAGES_PER_TERM:
                break
        if pages:
            out[term] = sorted(pages)[:MAX_PAGES_PER_TERM]
    return out


def render_index(doc, term_pages):
    """Render the index as text at the placeholder paragraph: letter groups, a
    bold term, then its page list. Returns the number of entries rendered."""
    text = doc.getText()
    target = None
    enum = text.createEnumeration()
    while enum.hasMoreElements():
        para = enum.nextElement()
        try:
            if para.supportsService("com.sun.star.text.Paragraph") and \
               para.getString().strip().startswith(INDEX_PLACEHOLDER[:40]):
                target = para
                break
        except Exception:  # noqa: BLE001
            pass
    if target is None:
        print("index placeholder not found")
        return 0

    cur = text.createTextCursorByRange(target.getEnd())
    entries = sorted(term_pages.keys(), key=lambda t: (t.lower(), t))
    last_letter = None
    count = 0
    for term in entries:
        first = term[0].upper()
        if not first.isalpha():
            first = "#"
        if first != last_letter:
            last_letter = first
            text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
            cur.setPropertyValue("CharWeight", BOLD)
            cur.setPropertyValue("CharHeight", 13.0)
            cur.setPropertyValue("CharColor", 0x52525B)
            text.insertString(cur, first, False)
        text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
        cur.setPropertyValue("CharWeight", BOLD)
        cur.setPropertyValue("CharHeight", 11.0)
        cur.setPropertyValue("CharColor", 0x18181B)
        text.insertString(cur, term, False)
        cur.setPropertyValue("CharWeight", NORMAL)
        cur.setPropertyValue("CharColor", 0x52525B)
        text.insertString(cur, "  " + ", ".join(str(p) for p in term_pages[term]), False)
        count += 1
    return count


def main():
    if len(sys.argv) < 3:
        print("usage: lo-convert.py <in.docx> <out.pdf> [terms.json]")
        return 2
    src, out = sys.argv[1], sys.argv[2]
    terms_path = sys.argv[3] if len(sys.argv) > 3 else None

    terms = []
    if terms_path:
        try:
            with open(terms_path, "r", encoding="utf-8") as f:
                terms = json.load(f)
        except Exception as e:  # noqa: BLE001
            print("terms read skipped:", e)

    ctx = officehelper.bootstrap()
    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    doc = desktop.loadComponentFromURL(
        unohelper.systemPathToFileUrl(src), "_blank", 0, (prop("Hidden", True),)
    )
    try:
        try:
            doc.getTextFields().refresh()
        except Exception as e:  # noqa: BLE001
            print("field refresh skipped:", e)

        # 1) Populate the TOC first so body pagination is final.
        toc_chars, cutoff = update_toc(doc)
        print("TOC entry chars:", toc_chars, "front-matter cutoff page:", cutoff)

        # 2) Compute each term's pages against the now-final pagination.
        term_pages = compute_term_pages(doc, terms, cutoff) if terms else {}
        print("index terms with pages:", len(term_pages))

        # 3) Render the index ourselves at the placeholder (end of the document).
        n = render_index(doc, term_pages)
        print("index entries rendered:", n)

        doc.storeToURL(unohelper.systemPathToFileUrl(out), (prop("FilterName", "writer_pdf_Export"),))
        print("wrote:", out)
    finally:
        doc.close(False)
    return 0


sys.exit(main())
