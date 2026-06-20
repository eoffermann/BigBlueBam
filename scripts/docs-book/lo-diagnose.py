#!/usr/bin/env python
# Diagnose why the TOC and alphabetical Index come out blank in the LibreOffice
# PDF. Loads the docx, enumerates the document indexes and text fields BEFORE and
# AFTER updating, and reports what LibreOffice actually recognized. Run with the
# LibreOffice bundled python:
#   "C:\Program Files\LibreOffice\program\python.exe" lo-diagnose.py <in.docx>
import sys
import officehelper
import unohelper


def main():
    src = sys.argv[1]
    ctx = officehelper.bootstrap()
    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    from com.sun.star.beans import PropertyValue
    p = PropertyValue(); p.Name = "Hidden"; p.Value = True
    doc = desktop.loadComponentFromURL(unohelper.systemPathToFileUrl(src), "_blank", 0, (p,))
    try:
        idx = doc.getDocumentIndexes()
        print("=== getDocumentIndexes count:", idx.getCount())
        for i in range(idx.getCount()):
            ix = idx.getByIndex(i)
            services = [s for s in ix.SupportedServiceNames if "Index" in s or "index" in s]
            try:
                name = ix.Name
            except Exception:
                name = "(no name)"
            try:
                before = len(ix.getAnchor().getString())
            except Exception as e:
                before = "ERR:%s" % e
            print("  [%d] name=%r services=%s anchorLen(before)=%s" % (i, name, services, before))

        # Update text fields then indexes.
        try:
            doc.getTextFields().refresh()
            print("=== text fields refreshed")
        except Exception as e:
            print("=== text field refresh ERR:", e)

        for i in range(idx.getCount()):
            ix = idx.getByIndex(i)
            # Inspect the create-from settings BEFORE forcing them.
            for prop in ("CreateFromOutline", "CreateFromMarks", "CreateFromLevelParagraphStyles", "Level"):
                try:
                    print("  [%d] %s = %r" % (i, prop, getattr(ix, prop)))
                except Exception as e:
                    print("  [%d] %s ? %s" % (i, prop, e))
            # Force build-from-outline (Heading 1-3 carry outline levels) then update.
            try:
                ix.CreateFromOutline = True
            except Exception as e:
                print("  [%d] set CreateFromOutline ERR: %s" % (i, e))
            try:
                ix.update()
                after = len(ix.getAnchor().getString())
                sample = ix.getAnchor().getString()[:200].replace("\n", " | ")
                print("  [%d] updated. anchorLen(after)=%s sample=%r" % (i, after, sample))
            except Exception as e:
                print("  [%d] update ERR: %s" % (i, e))

        # Enumerate text fields to see what stayed a FIELD (TOC/INDEX/XE not converted).
        tf = doc.getTextFields().createEnumeration()
        kinds = {}
        while tf.hasMoreElements():
            f = tf.nextElement()
            present = f.SupportedServiceNames
            key = None
            for s in present:
                if s.startswith("com.sun.star.text.TextField."):
                    key = s.split(".")[-1]
                    break
            kinds[key or "?"] = kinds.get(key or "?", 0) + 1
        print("=== remaining text-field kinds:", kinds)
    finally:
        doc.close(False)
    return 0


sys.exit(main())
