#!/usr/bin/env python
# Convert a DOCX to PDF with LibreOffice via UNO, UPDATING fields and indexes
# first. Plain `soffice --convert-to pdf` does NOT refresh TOC/INDEX fields, so a
# generated Table of Contents and alphabetical Index come out blank. This loads
# the doc, refreshes text fields, updates every document index (TOC + Index),
# then exports the PDF. Run with LibreOffice's bundled python:
#   "C:\Program Files\LibreOffice\program\python.exe" lo-convert.py <in.docx> <out.pdf>
import sys
import officehelper
import unohelper
from com.sun.star.beans import PropertyValue


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def main():
    if len(sys.argv) < 3:
        print("usage: lo-convert.py <in.docx> <out.pdf>")
        return 2
    src, out = sys.argv[1], sys.argv[2]
    ctx = officehelper.bootstrap()
    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    doc = desktop.loadComponentFromURL(
        unohelper.systemPathToFileUrl(src), "_blank", 0, (prop("Hidden", True),)
    )
    try:
        # Refresh text fields (page refs, etc.).
        try:
            doc.getTextFields().refresh()
        except Exception as e:  # noqa: BLE001
            print("field refresh skipped:", e)
        # Update every index: Table of Contents and the alphabetical Index.
        try:
            indexes = doc.getDocumentIndexes()
            n = indexes.getCount()
            for i in range(n):
                indexes.getByIndex(i).update()
            print("updated indexes:", n)
        except Exception as e:  # noqa: BLE001
            print("index update skipped:", e)
        doc.storeToURL(unohelper.systemPathToFileUrl(out), (prop("FilterName", "writer_pdf_Export"),))
        print("wrote:", out)
    finally:
        doc.close(False)
    return 0


sys.exit(main())
