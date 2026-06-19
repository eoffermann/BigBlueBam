#!/usr/bin/env node
/**
 * build-book.mjs - assemble the printable, textbook-style BigBlueBam manual.
 *
 * Reads the SAME content the /docs page renders (site/src/content/manual.generated.json),
 * layers on an authored enhancement file per chapter (intro, pull-quotes, callouts,
 * quiz), and emits a bold, colorful, per-app DOCX laid out per docs/docs-book-style-guide.md.
 * Then converts the DOCX to PDF with headless LibreOffice.
 *
 * Usage:
 *   node build-book.mjs            # full 16-chapter book
 *   node build-book.mjs --app=bam  # single-chapter sample (BigBlueBam-Bam-sample.docx)
 *   node build-book.mjs --app=bam --pdf
 *   node build-book.mjs --pdf      # full book + pdf
 *
 * No em dashes in any generated string (house rule).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { marked } from 'marked';
import {
  Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  AlignmentType, PageBreak, Header, Footer, PageNumber, TabStopType, TabStopPosition,
} from 'docx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const MANUAL = path.join(ROOT, 'site', 'src', 'content', 'manual.generated.json');
const PUBLIC = path.join(ROOT, 'site', 'public');
const ENH_DIR = path.join(__dirname, 'enhancements');
const OUT_DIR = path.join(PUBLIC, 'downloads');

// --- design system (see docs/docs-book-style-guide.md) -----------------------
const ACCENT = {
  bam: '2563EB', banter: '7C3AED', beacon: '059669', bearing: '0891B2',
  bench: '4F46E5', bill: '16A34A', blank: '9333EA', blast: 'DC2626',
  blueprint: '0284C7', board: '4338CA', bolt: 'EA580C', bond: 'DB2777',
  book: '0D9488', brief: 'D97706', bureau: '6D28D9', helpdesk: 'E11D48',
};
const INK = '18181B', SUBTLE = '52525B', HAIR = 'E4E4E7', CODEBG = 'F4F4F5';
const SEMANTIC = { tip: null, important: 'D97706', warning: 'DC2626', note: '475569', tryit: '059669' };
const LABEL = { tip: 'TIP', important: 'IMPORTANT', warning: 'WARNING', note: 'NOTE', tryit: 'TRY IT' };
const SERIF = 'Georgia', SANS = 'Arial', MONO = 'Consolas';

/** Blend a hex toward white. amount 0..1 (1 = white). */
function tint(hex, amount) {
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const m = (c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0');
  return (m(r) + m(g) + m(b)).toUpperCase();
}

/** Read a PNG's intrinsic pixel size from its IHDR header. */
function pngSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch { return null; }
}

function loadEnh(app) {
  const f = path.join(ENH_DIR, `${app}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

// --- inline markdown tokens -> docx TextRuns ---------------------------------
function inlineRuns(tokens, accent, base = {}) {
  const runs = [];
  for (const t of tokens || []) {
    if (t.type === 'text') {
      if (t.tokens && t.tokens.length) runs.push(...inlineRuns(t.tokens, accent, base));
      else runs.push(new TextRun({ text: t.text, font: SERIF, color: INK, ...base }));
    } else if (t.type === 'strong') {
      runs.push(...inlineRuns(t.tokens, accent, { ...base, bold: true }));
    } else if (t.type === 'em') {
      runs.push(...inlineRuns(t.tokens, accent, { ...base, italics: true }));
    } else if (t.type === 'codespan') {
      runs.push(new TextRun({ text: t.text, font: MONO, color: accent, size: 20, ...base }));
    } else if (t.type === 'link') {
      runs.push(...inlineRuns(t.tokens, accent, { ...base, color: accent, underline: {} }));
    } else if (t.type === 'br') {
      runs.push(new TextRun({ break: 1 }));
    } else if (t.text) {
      runs.push(new TextRun({ text: t.text, font: SERIF, color: INK, ...base }));
    }
  }
  return runs.length ? runs : [new TextRun({ text: '', font: SERIF })];
}
function plain(tokens) {
  return (tokens || []).map((t) => t.tokens ? plain(t.tokens) : (t.text || '')).join('');
}

// --- block builders ----------------------------------------------------------
function heading(text, level, accent) {
  const sizes = { 2: 30, 3: 24, 4: 19 };
  const children = [];
  if (level === 2) {
    children.push(new Paragraph({
      spacing: { before: 60, after: 60 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: accent, space: 1 } },
      children: [new TextRun({ text: '', size: 2 })],
    }));
  }
  children.push(new Paragraph({
    heading: level === 2 ? HeadingLevel.HEADING_2 : level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4,
    spacing: { before: level === 2 ? 120 : 200, after: 100 },
    keepNext: true,
    children: [new TextRun({ text, bold: true, font: SANS, color: accent, size: sizes[level] || 19 })],
  }));
  return children;
}

function calloutBox(type, text, accent) {
  const color = SEMANTIC[type] || accent;
  const fill = tint(color, 0.88);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: noBorders(),
    rows: [new TableRow({ children: [new TableCell({
      shading: { type: ShadingType.CLEAR, fill },
      borders: { left: { style: BorderStyle.SINGLE, size: 30, color }, top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
      margins: { top: 120, bottom: 120, left: 180, right: 160 },
      children: [
        new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: LABEL[type] || 'NOTE', bold: true, font: SANS, color, size: 17 })] }),
        new Paragraph({ children: inlineRuns(marked.lexer(text)[0]?.tokens, accent) }),
      ],
    })] })],
  });
}

function pullQuote(text, accent) {
  return new Paragraph({
    spacing: { before: 160, after: 160 },
    indent: { left: 360, right: 360 },
    border: { left: { style: BorderStyle.SINGLE, size: 48, color: accent, space: 12 } },
    children: [new TextRun({ text, italics: true, bold: true, font: SANS, color: accent, size: 30 })],
  });
}

function noBorders() {
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  return { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
}

function colorPanel(fill, children, margins = { top: 360, bottom: 360, left: 320, right: 320 }) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: noBorders(),
    rows: [new TableRow({ children: [new TableCell({ shading: { type: ShadingType.CLEAR, fill }, borders: noBorders(), margins, children })] })],
  });
}

function chapterOpener(app, title, tagline, intro, atAGlance, toc, accent, num) {
  const out = [];
  const white = 'FFFFFF';
  const panelKids = [
    new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: `CHAPTER ${num}`, bold: true, font: SANS, color: tint(accent, 0.55), size: 26 })] }),
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: titleName(app, title), bold: true, font: SANS, color: white, size: 80 })] }),
    new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: tagline || '', font: SANS, color: white, size: 28 })] }),
  ];
  out.push(colorPanel(accent, panelKids));
  // Intro card (dark text on white) sitting just under the color panel.
  if (intro) {
    out.push(new Paragraph({ spacing: { before: 0, after: 0 }, children: [] }));
    out.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE }, borders: noBorders(),
      rows: [new TableRow({ children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: 'FFFFFF' },
        borders: { top: { style: BorderStyle.SINGLE, size: 12, color: accent }, bottom: { style: BorderStyle.SINGLE, size: 6, color: HAIR }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
        margins: { top: 200, bottom: 200, left: 240, right: 240 },
        children: [new Paragraph({ children: [new TextRun({ text: intro, font: SERIF, color: INK, size: 24 })] })],
      })] })],
    }));
  }
  if (Array.isArray(atAGlance) && atAGlance.length) {
    out.push(new Paragraph({ spacing: { before: 260, after: 80 }, children: [new TextRun({ text: 'At a glance', bold: true, font: SANS, color: accent, size: 22 })] }));
    for (const item of atAGlance) {
      out.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: [new TextRun({ text: item, font: SERIF, color: INK, size: 22 })] }));
    }
  }
  if (Array.isArray(toc) && toc.length) {
    out.push(new Paragraph({ spacing: { before: 200, after: 60 }, children: [new TextRun({ text: 'In this chapter', bold: true, font: SANS, color: SUBTLE, size: 18 })] }));
    out.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: toc.slice(0, 10).map((t) => (typeof t === 'string' ? t : t.text || t.title || '')).filter(Boolean).join('   .   '), font: SANS, color: SUBTLE, size: 18 })] }));
  }
  return out;
}

function titleName(app, title) {
  // Prefer the friendly app name (cap), strip any "App - subtitle" tail from the H1.
  const t = (title || app).split(' - ')[0].split(' — ')[0].trim();
  return t || (app.charAt(0).toUpperCase() + app.slice(1));
}

function quizBlock(quiz, accent, num) {
  if (!Array.isArray(quiz) || !quiz.length) return [];
  const out = [];
  out.push(new Paragraph({ spacing: { before: 320, after: 0 }, children: [] }));
  const inner = [
    new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: 'Check yourself', bold: true, font: SANS, color: accent, size: 28 })] }),
  ];
  quiz.forEach((item, i) => {
    inner.push(new Paragraph({ spacing: { before: 100, after: 40 }, children: [
      new TextRun({ text: `${i + 1}. `, bold: true, font: SERIF, color: INK, size: 22 }),
      new TextRun({ text: item.q, font: SERIF, color: INK, size: 22 }),
    ] }));
    if (item.type === 'mc' && Array.isArray(item.choices)) {
      item.choices.forEach((c, ci) => {
        inner.push(new Paragraph({ indent: { left: 360 }, spacing: { after: 20 }, children: [
          new TextRun({ text: `${String.fromCharCode(97 + ci)}) `, font: SERIF, color: SUBTLE, size: 21 }),
          new TextRun({ text: c, font: SERIF, color: INK, size: 21 }),
        ] }));
      });
    }
  });
  out.push(colorPanel(tint(accent, 0.9), inner, { top: 240, bottom: 240, left: 280, right: 280 }));
  // Answer key
  out.push(new Paragraph({ spacing: { before: 160, after: 60 }, children: [new TextRun({ text: 'Answer key', bold: true, font: SANS, color: SUBTLE, size: 18 })] }));
  quiz.forEach((item, i) => {
    let ans = item.answer;
    if (item.type === 'mc' && Array.isArray(item.choices)) {
      const idx = item.choices.findIndex((c) => c === item.answer);
      if (idx >= 0) ans = `${String.fromCharCode(97 + idx)}) ${item.answer}`;
    }
    out.push(new Paragraph({ spacing: { after: 20 }, children: [
      new TextRun({ text: `${i + 1}. `, bold: true, font: SANS, color: SUBTLE, size: 18 }),
      new TextRun({ text: ans, font: SANS, color: SUBTLE, size: 18 }),
      ...(item.where ? [new TextRun({ text: `  (see: ${item.where})`, italics: true, font: SANS, color: SUBTLE, size: 16 })] : []),
    ] }));
  });
  return out;
}

// --- render one chapter's markdown body --------------------------------------
function renderBody(md, enh, accent, chapterNum, figState) {
  const tokens = marked.lexer(md);
  const out = [];
  let seenH1 = false;
  const callouts = enh.callouts || [];
  const pulls = enh.pullQuotes || [];
  const firedC = new Set();
  const firedP = new Set();
  // Emit any callouts/pull-quotes whose anchor substring appears in `text`.
  // Anchors fire once; they match against paragraph OR list-item text. The
  // source markdown is hard-wrapped, so collapse all whitespace before matching
  // (otherwise an anchor phrase that crosses a line wrap silently never fires).
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const anchoredFor = (text) => {
    const t = norm(text);
    const els = [];
    callouts.forEach((c, i) => {
      if (c.after && !firedC.has(i) && t.includes(norm(c.after))) { firedC.add(i); els.push(calloutBox(c.type || 'note', c.text, accent)); }
    });
    pulls.forEach((q, i) => {
      if (q.after && !firedP.has(i) && t.includes(norm(q.after))) { firedP.add(i); els.push(pullQuote(q.text, accent)); }
    });
    return els;
  };

  for (const tok of tokens) {
    if (tok.type === 'heading') {
      if (tok.depth === 1) { if (!seenH1) { seenH1 = true; continue; } continue; }
      out.push(...heading(tok.text, Math.min(tok.depth, 4), accent));
    } else if (tok.type === 'paragraph') {
      // image-only paragraph?
      const img = (tok.tokens || []).find((t) => t.type === 'image');
      if (img && (tok.tokens || []).filter((t) => t.type !== 'space' && !(t.type === 'text' && !t.text.trim())).length === 1) {
        out.push(...figure(img, accent, chapterNum, figState));
        continue;
      }
      out.push(new Paragraph({ spacing: { after: 120, line: 300 }, alignment: AlignmentType.LEFT, children: inlineRuns(tok.tokens, accent) }));
      out.push(...anchoredFor(plain(tok.tokens)));
    } else if (tok.type === 'blockquote') {
      const inner = (tok.tokens || []).filter((t) => t.type === 'paragraph').map((p) => new Paragraph({
        spacing: { after: 60, line: 300 }, indent: { left: 300 },
        border: { left: { style: BorderStyle.SINGLE, size: 24, color: tint(accent, 0.4), space: 10 } },
        children: inlineRuns(p.tokens, accent, { italics: true, color: SUBTLE }),
      }));
      out.push(...inner);
    } else if (tok.type === 'list') {
      let listText = '';
      let n = typeof tok.start === 'number' && tok.start ? tok.start : 1;
      tok.items.forEach((it) => {
        listText += ' ' + (it.text || '');
        const itemRuns = inlineRuns(it.tokens && it.tokens[0] && it.tokens[0].tokens ? it.tokens[0].tokens : [{ type: 'text', text: it.text }], accent);
        if (tok.ordered) {
          out.push(new Paragraph({
            spacing: { after: 40, line: 290 }, indent: { left: 380, hanging: 240 },
            children: [new TextRun({ text: `${n}.  `, bold: true, font: SERIF, color: accent, size: 22 }), ...itemRuns],
          }));
          n += 1;
        } else {
          out.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 40, line: 290 }, children: itemRuns }));
        }
      });
      // Callouts/pull-quotes anchored to list-item text emit after the list.
      out.push(...anchoredFor(listText));
    } else if (tok.type === 'code') {
      const lines = tok.text.split('\n');
      out.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE }, borders: noBorders(),
        rows: [new TableRow({ children: [new TableCell({
          shading: { type: ShadingType.CLEAR, fill: CODEBG },
          borders: { left: { style: BorderStyle.SINGLE, size: 24, color: accent }, top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          margins: { top: 120, bottom: 120, left: 160, right: 120 },
          children: lines.map((ln) => new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: ln || ' ', font: MONO, color: INK, size: 19 })] })),
        })] })],
      }));
      out.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
    } else if (tok.type === 'table') {
      out.push(mdTable(tok, accent));
    } else if (tok.type === 'hr') {
      out.push(new Paragraph({ spacing: { before: 80, after: 80 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: HAIR } }, children: [new TextRun({ text: '', size: 2 })] }));
    }
  }
  return out;
}

function figure(img, accent, chapterNum, figState) {
  const out = [];
  const rel = (img.href || '').replace(/^\//, '');
  const file = path.join(PUBLIC, rel);
  const dims = pngSize(file);
  if (dims && fs.existsSync(file)) {
    const maxW = 580;
    const w = Math.min(maxW, dims.w);
    const h = Math.round(dims.h * (w / dims.w));
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 120, after: 40 },
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: HAIR }, bottom: { style: BorderStyle.SINGLE, size: 4, color: HAIR }, left: { style: BorderStyle.SINGLE, size: 4, color: HAIR }, right: { style: BorderStyle.SINGLE, size: 4, color: HAIR } },
      children: [new ImageRun({ type: 'png', data: fs.readFileSync(file), transformation: { width: w, height: h } })],
    }));
  }
  figState.n += 1;
  const cap = (img.text || img.title || 'Screenshot').trim();
  out.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 160 },
    children: [
      new TextRun({ text: `Figure ${chapterNum}.${figState.n}  `, bold: true, italics: true, font: SANS, color: accent, size: 17 }),
      new TextRun({ text: cap, italics: true, font: SANS, color: SUBTLE, size: 17 }),
    ],
  }));
  return out;
}

function mdTable(tok, accent) {
  const headFill = tint(accent, 0.85);
  const rows = [];
  rows.push(new TableRow({ tableHeader: true, children: tok.header.map((c) => new TableCell({
    shading: { type: ShadingType.CLEAR, fill: headFill }, margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text: plain(c.tokens), bold: true, font: SANS, color: INK, size: 19 })] })],
  })) }));
  tok.rows.forEach((r) => rows.push(new TableRow({ children: r.map((c) => new TableCell({
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: inlineRuns(c.tokens, accent, { size: 19 }) })],
  })) })));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

// --- assemble ----------------------------------------------------------------
function chapterSection(chapter, num) {
  const app = chapter.app;
  const accent = ACCENT[app] || '2563EB';
  const enh = loadEnh(app);
  const figState = { n: 0 };
  const children = [
    ...chapterOpener(app, chapter.title, enh.tagline, enh.intro, enh.atAGlance, chapter.toc, accent, num),
    new Paragraph({ children: [new PageBreak()] }),
    ...renderBody(chapter.markdown, enh, accent, num, figState),
    ...quizBlock(enh.quiz, accent, num),
  ];
  return {
    properties: { page: { margin: { top: 1440, bottom: 1440, left: 1584, right: 1440 } } },
    headers: { default: new Header({ children: [new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: accent } },
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      children: [new TextRun({ text: titleName(app, chapter.title), font: SANS, color: accent, size: 16, bold: true }), new TextRun({ text: '\tBigBlueBam Manual', font: SANS, color: SUBTLE, size: 16 })],
    })] }) },
    footers: { default: new Footer({ children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ children: [PageNumber.CURRENT], font: SANS, color: SUBTLE, size: 16 })],
    })] }) },
    children,
  };
}

function titleSection(single) {
  const a = '2563EB';
  const kids = [
    new Paragraph({ spacing: { before: 1400, after: 0 }, children: [new TextRun({ text: 'BigBlueBam', bold: true, font: SANS, color: a, size: 96 })] }),
    new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: single ? 'The Complete Manual (sample chapter)' : 'The Complete Manual', font: SANS, color: INK, size: 40 })] }),
    new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: 'Sixteen apps that behave like one. A field guide.', font: SERIF, italics: true, color: SUBTLE, size: 26 })] }),
    new Paragraph({ children: [new TextRun({ text: 'Open source. Self-hosted. Built for humans and AI agents.', font: SANS, color: SUBTLE, size: 20 })] }),
  ];
  return { properties: {}, children: [colorPanel(tint(a, 0.92), kids, { top: 480, bottom: 480, left: 360, right: 360 })] };
}

async function main() {
  const args = process.argv.slice(2);
  const appArg = (args.find((a) => a.startsWith('--app=')) || '').split('=')[1] || null;
  const wantPdf = args.includes('--pdf');

  const manual = JSON.parse(fs.readFileSync(MANUAL, 'utf8'));
  const chapters = appArg ? manual.filter((c) => c.app === appArg) : manual;
  if (!chapters.length) { console.error(`No chapter for --app=${appArg}`); process.exit(1); }

  const sections = [titleSection(!!appArg)];
  chapters.forEach((c, i) => {
    const num = appArg ? (manual.findIndex((m) => m.app === c.app) + 1) : i + 1;
    sections.push(chapterSection(c, num));
  });

  const doc = new Document({
    creator: 'BigBlueBam', title: 'BigBlueBam Manual',
    styles: { default: { document: { run: { font: SERIF, size: 22, color: INK } } } },
    sections,
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = appArg ? `BigBlueBam-${titleName(appArg, chapters[0].title)}-sample` : 'BigBlueBam-Manual';
  const docxPath = path.join(OUT_DIR, `${base}.docx`);
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buf);
  console.log(`DOCX -> ${path.relative(ROOT, docxPath)}  (${(buf.length / 1024).toFixed(0)} KB)`);

  if (wantPdf) {
    const soffice = process.platform === 'win32'
      ? 'C:\\Program Files\\LibreOffice\\program\\soffice.exe' : 'soffice';
    const pdfPath = docxPath.replace(/\.docx$/, '.pdf');
    try { fs.rmSync(pdfPath, { force: true }); } catch {}
    const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
    const killStale = () => {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/IM', 'soffice.exe', '/T'], { stdio: 'ignore' });
        spawnSync('taskkill', ['/F', '/IM', 'soffice.bin', '/T'], { stdio: 'ignore' });
      } else { spawnSync('pkill', ['-f', 'soffice'], { stdio: 'ignore' }); }
    };
    // LibreOffice is single-instance; a stale process or a self-update can hold
    // the lock and make --convert-to silently no-op. Kill-and-retry once.
    let ok = false;
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      const r = spawnSync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', OUT_DIR, docxPath], { stdio: 'inherit' });
      ok = r.status === 0 && fs.existsSync(pdfPath);
      if (!ok && attempt === 1) { console.error('PDF conversion did not land; clearing LibreOffice and retrying...'); killStale(); sleep(4000); }
    }
    if (ok) console.log(`PDF  -> ${path.relative(ROOT, pdfPath)}`);
    else console.error('PDF conversion failed. A LibreOffice self-update or lock may be active; close LibreOffice and re-run.');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
