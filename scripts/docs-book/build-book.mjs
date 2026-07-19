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
  AlignmentType, PageBreak, Header, Footer, PageNumber,
  SectionType, TableOfContents, FootnoteReferenceRun, SimpleField,
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
  bay: 'DB2777', bin: '0369A1', blip: '0891B2', basis: '4F46E5',
  braid: '4338CA', bulwark: '1D4ED8',
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

// --- glossary parsing (from the "Key concepts" definition list) --------------
function parseGlossary(md) {
  // The glossary is ONLY the "Key concepts" section's definition list, not every
  // bold bullet in the chapter (integrations, nav lists, platform bullets, etc.).
  const sec = md.match(/#{2,4}\s+Key concepts[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/i);
  const scope = sec ? sec[1] : '';
  const out = [];
  // Split into bullet items (each definition is hard-wrapped across lines), then
  // take the FULL item text. A single regex with `$` under /m stops at the first
  // line wrap, which truncated every definition mid-sentence.
  for (const raw of scope.split(/\n(?=[-*]\s+\*\*)/)) {
    const m = raw.match(/^[-*]\s+\*\*([^*]+)\*\*\s*[-–:]\s*([\s\S]*)$/);
    if (!m) continue;
    const term = m[1].trim();
    const def = m[2].replace(/\s+/g, ' ').trim();
    if (term && def && term.length <= 40) out.push({ term, def });
  }
  return out;
}

/** Build a decoration context: glossary regex + footnote/index state. */
function buildCtx(glossary, fnState) {
  if (!glossary.length) return null;
  const byLower = new Map();
  glossary.forEach((g) => byLower.set(g.term.toLowerCase(), g));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alt = glossary.map((g) => esc(g.term)).sort((a, b) => b.length - a.length).join('|');
  return { byLower, re: new RegExp(`\\b(${alt})\\b`, 'gi'), firstSeen: new Set(), fnState };
}

/** Split plain text around glossary terms; footnote first use, index every use. */
function decorateText(text, base, ctx) {
  if (!ctx) return [new TextRun({ text, font: SERIF, color: INK, ...base })];
  const runs = [];
  let last = 0;
  ctx.re.lastIndex = 0;
  let m;
  while ((m = ctx.re.exec(text))) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), font: SERIF, color: INK, ...base }));
    const word = m[0];
    const key = word.toLowerCase();
    const entry = ctx.byLower.get(key);
    runs.push(new TextRun({ text: word, font: SERIF, color: INK, ...base }));
    // Index mark on every occurrence (hidden XE field).
    runs.push(new SimpleField(`XE "${entry.term}"`));
    // Footnote on first occurrence.
    if (!ctx.firstSeen.has(key)) {
      ctx.firstSeen.add(key);
      const id = ctx.fnState.next++;
      ctx.fnState.reg[id] = { children: [new Paragraph({ children: [new TextRun({ text: `${entry.term}. `, bold: true, font: SERIF, size: 18 }), ...inlineMd(entry.def, '2563EB', { size: 18 })] })] };
      runs.push(new FootnoteReferenceRun(id));
    }
    last = m.index + word.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), font: SERIF, color: INK, ...base }));
  return runs;
}

// --- inline markdown tokens -> docx TextRuns ---------------------------------
function inlineRuns(tokens, accent, base = {}, ctx = null) {
  const runs = [];
  for (const t of tokens || []) {
    if (t.type === 'text') {
      if (t.tokens && t.tokens.length) runs.push(...inlineRuns(t.tokens, accent, base, ctx));
      else runs.push(...decorateText(t.text, base, ctx));
    } else if (t.type === 'strong') {
      runs.push(...inlineRuns(t.tokens, accent, { ...base, bold: true }, ctx));
    } else if (t.type === 'em') {
      runs.push(...inlineRuns(t.tokens, accent, { ...base, italics: true }, ctx));
    } else if (t.type === 'codespan') {
      runs.push(new TextRun({ text: t.text, font: MONO, color: accent, size: 20, ...base }));
    } else if (t.type === 'link') {
      runs.push(...inlineRuns(t.tokens, accent, { ...base, color: accent, underline: {} }, ctx));
    } else if (t.type === 'br') {
      runs.push(new TextRun({ break: 1 }));
    } else if (t.text) {
      runs.push(...decorateText(t.text, base, ctx));
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
      // H2 is a major subsection; start it on a new page (its accent rule leads).
      pageBreakBefore: true,
      spacing: { before: 60, after: 60 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: accent, space: 1 } },
      children: [new TextRun({ text: '', size: 2 })],
    }));
  }
  children.push(new Paragraph({
    heading: level === 2 ? HeadingLevel.HEADING_2 : level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4,
    // Explicit outline level so LibreOffice's build-from-outline TOC finds it.
    // The docx heading STYLES carry no w:outlineLvl, so without this the TOC is blank.
    outlineLevel: level - 1,
    spacing: { before: level === 2 ? 120 : 200, after: 100 },
    keepNext: true,
    children: [new TextRun({ text, bold: true, font: SANS, color: accent, size: sizes[level] || 19 })],
  }));
  return children;
}

// Render a string of inline markdown (bold, italic, `code`, links) to styled
// runs. Used where source text reaches a leaf unrendered (glossary defs,
// footnote defs) so backticks and asterisks become real formatting, not literals.
function inlineMd(text, accent, base = {}) {
  const toks = marked.lexer(text || '');
  const p = toks.find((t) => t.type === 'paragraph') || toks[0];
  return inlineRuns(p && p.tokens ? p.tokens : [{ type: 'text', text: text || '' }], accent, base);
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
    // HEADING_1 so the Table of Contents captures the chapter as a level-1 entry;
    // explicit run props keep the big white display look on the color panel.
    new Paragraph({ heading: HeadingLevel.HEADING_1, outlineLevel: 0, spacing: { before: 0, after: 60 }, children: [new TextRun({ text: titleName(app, title), bold: true, font: SANS, color: white, size: 80 })] }),
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

// The end-of-chapter quiz: QUESTIONS ONLY. Answers live in the Answer Key
// appendix at the back of the book (see answerKeySection), so the reader is not
// tempted by an answer on the same page.
function quizBlock(quiz, accent, num) {
  if (!Array.isArray(quiz) || !quiz.length) return [];
  const out = [];
  // "Check yourself" starts on a fresh page, splitting the review from the chapter.
  out.push(new Paragraph({ children: [new PageBreak()] }));
  const inner = [
    new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: 'Check yourself', bold: true, font: SANS, color: accent, size: 28 })] }),
    new Paragraph({ spacing: { after: 140 }, children: [new TextRun({ text: 'Every answer is findable in this chapter. Check your work against the Answer Key appendix at the back of the book.', italics: true, font: SANS, color: SUBTLE, size: 18 })] }),
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
  return out;
}

// Back-matter appendix: every chapter's quiz answers, grouped by chapter, each
// citing the section where the reader can confirm it. Sits after the chapters
// and before the glossary and index.
function answerKeySection(chapters, accent) {
  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, outlineLevel: 0, spacing: { before: 120, after: 80 }, children: [new TextRun({ text: 'Answer Key', bold: true, font: SANS, color: accent, size: 48 })] }),
    new Paragraph({ spacing: { after: 220 }, children: [new TextRun({ text: 'Answers to every "Check yourself" review, grouped by chapter. Each answer cites the section where you can confirm it.', italics: true, font: SERIF, color: SUBTLE, size: 22 })] }),
  ];
  chapters.forEach((ch) => {
    const acc = ACCENT[ch.app] || accent;
    // A styled (not heading-level) label so the 16 chapter rows do not flood the TOC.
    children.push(new Paragraph({ spacing: { before: 240, after: 80 }, keepNext: true,
      border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: acc, space: 2 } },
      children: [new TextRun({ text: `Chapter ${ch.num}. ${titleName(ch.app, ch.title)}`, bold: true, font: SANS, color: acc, size: 26 })] }));
    ch.quiz.forEach((item, i) => {
      let ans = item.answer;
      if (item.type === 'mc' && Array.isArray(item.choices)) {
        const idx = item.choices.findIndex((c) => c === item.answer);
        if (idx >= 0) ans = `${String.fromCharCode(97 + idx)}) ${item.answer}`;
      }
      children.push(new Paragraph({ spacing: { after: 50, line: 290 }, indent: { left: 380, hanging: 260 }, children: [
        new TextRun({ text: `${i + 1}.  `, bold: true, font: SERIF, color: acc, size: 21 }),
        new TextRun({ text: ans, font: SERIF, color: INK, size: 21 }),
        ...(item.where ? [new TextRun({ text: `  (see: ${item.where})`, italics: true, font: SERIF, color: SUBTLE, size: 19 })] : []),
      ] }));
    });
  });
  return { properties: { type: SectionType.ODD_PAGE, page: PAGE }, footers: { default: pageFooter() }, children };
}

// --- render one chapter's markdown body --------------------------------------
function renderBody(md, enh, accent, chapterNum, figState, ctx) {
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

  // Next non-space token, used to keep the paragraph just above a table glued
  // to it (so a heading + intro + table block bumps to the next page together).
  const nextMeaningful = (from) => { for (let j = from + 1; j < tokens.length; j++) { if (tokens[j].type !== 'space') return tokens[j]; } return null; };
  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];
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
      const nxt = nextMeaningful(ti);
      out.push(new Paragraph({ spacing: { after: 120, line: 300 }, alignment: AlignmentType.LEFT,
        keepNext: !!(nxt && nxt.type === 'table'),
        children: inlineRuns(tok.tokens, accent, {}, ctx) }));
      out.push(...anchoredFor(plain(tok.tokens)));
    } else if (tok.type === 'blockquote') {
      const paras = (tok.tokens || []).filter((t) => t.type === 'paragraph');
      const inner = paras.map((p) => new Paragraph({
        spacing: { after: 60, line: 300 }, indent: { left: 300 },
        border: { left: { style: BorderStyle.SINGLE, size: 24, color: tint(accent, 0.4), space: 10 } },
        children: inlineRuns(p.tokens, accent, { italics: true, color: SUBTLE }),
      }));
      out.push(...inner);
      // Chapter intros and "Known limitation" notes are blockquotes, so anchors
      // (pull-quotes, callouts) can legitimately point at blockquote text too.
      out.push(...anchoredFor(paras.map((p) => plain(p.tokens)).join(' ')));
    } else if (tok.type === 'list') {
      let listText = '';
      let n = typeof tok.start === 'number' && tok.start ? tok.start : 1;
      tok.items.forEach((it) => {
        listText += ' ' + (it.text || '');
        const itemRuns = inlineRuns(it.tokens && it.tokens[0] && it.tokens[0].tokens ? it.tokens[0].tokens : [{ type: 'text', text: it.text }], accent, {}, ctx);
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
    // Fit within the column width AND a max height so the image plus its caption
    // never overflow one page (a tall screenshot otherwise fills the page and
    // pushes the caption onto the next one). Shrink proportionally when needed.
    const maxW = 580; // ~6 in column
    const maxH = 700; // ~7.3 in, leaving room for the caption + spacing on a page
    let w = Math.min(maxW, dims.w);
    let h = Math.round(dims.h * (w / dims.w));
    if (h > maxH) { h = maxH; w = Math.round(dims.w * (maxH / dims.h)); }
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 120, after: 40 },
      keepNext: true, // keep the image with its caption (next paragraph)
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
  // Keep a short table together: cantSplit stops a single row straddling a page,
  // and keepNext chains every row (except the last) to the next so the whole
  // table, plus its heading and intro text (also keepNext), bumps to the next
  // page rather than splitting. A table taller than a page still splits, because
  // keepNext is best-effort and cannot fit the impossible.
  rows.push(new TableRow({ tableHeader: true, cantSplit: true, children: tok.header.map((c) => new TableCell({
    shading: { type: ShadingType.CLEAR, fill: headFill }, margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ keepNext: true, children: [new TextRun({ text: plain(c.tokens), bold: true, font: SANS, color: INK, size: 19 })] })],
  })) }));
  tok.rows.forEach((r, ri) => {
    const keep = ri < tok.rows.length - 1; // last row does not glue to the next section
    rows.push(new TableRow({ cantSplit: true, children: r.map((c) => new TableCell({
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ keepNext: keep, children: inlineRuns(c.tokens, accent, { size: 19 }) })],
    })) }));
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

// --- assemble ----------------------------------------------------------------

// Running header: a borderless two-cell table at 100% content width, with a
// shared bottom border. The right cell is right-aligned, so the text's right
// edge and the rule's right edge are the SAME content-width edge (fixes the
// header-wider-than-rule mismatch from the tab-stop version).
function runningHeader(app, title, accent) {
  const noTopSideBorders = { top: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.SINGLE, size: 8, color: accent } };
  return new Header({ children: [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: noBorders(),
    columnWidths: [5000, 5000],
    rows: [new TableRow({ children: [
      new TableCell({ borders: noTopSideBorders, margins: { bottom: 40, left: 0, right: 0 }, children: [new Paragraph({ children: [new TextRun({ text: titleName(app, title), font: SANS, color: accent, size: 16, bold: true })] })] }),
      new TableCell({ borders: noTopSideBorders, margins: { bottom: 40, left: 0, right: 0 }, children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'BigBlueBam Manual', font: SANS, color: SUBTLE, size: 16 })] })] }),
    ] })],
  })] });
}

function pageFooter() {
  return new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: SANS, color: SUBTLE, size: 16 })] })] });
}

const PAGE_MARGIN = { top: 1440, bottom: 1440, left: 1584, right: 1440 };
const PAGE = { size: { width: 12240, height: 15840 }, margin: PAGE_MARGIN }; // US Letter

function chapterSection(chapter, num, ctx, enh) {
  const app = chapter.app;
  const accent = ACCENT[app] || '2563EB';
  const figState = { n: 0 };
  const children = [
    ...chapterOpener(app, chapter.title, enh.tagline, enh.intro, enh.atAGlance, chapter.toc, accent, num),
    // No manual page break here: the first body H2 carries pageBreakBefore, so it
    // opens the next page on its own (a manual break here would leave a blank page).
    ...renderBody(chapter.markdown, enh, accent, num, figState, ctx),
    ...quizBlock(enh.quiz, accent, num),
  ];
  return {
    // Chapters start on an ODD (right-hand, recto) page like a real textbook.
    properties: { type: SectionType.ODD_PAGE, page: PAGE },
    headers: { default: runningHeader(app, chapter.title, accent) },
    footers: { default: pageFooter() },
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
  return { properties: { page: PAGE }, children: [colorPanel(tint(a, 0.92), kids, { top: 480, bottom: 480, left: 360, right: 360 })] };
}

function tocSection() {
  const a = '2563EB';
  return {
    // ODD page so the TOC opens on a right-hand page, not the inside-front-cover position.
    properties: { type: SectionType.ODD_PAGE, page: PAGE },
    footers: { default: pageFooter() },
    children: [
      new Paragraph({ spacing: { before: 240, after: 200 }, children: [new TextRun({ text: 'Table of Contents', bold: true, font: SANS, color: a, size: 48 })] }),
      new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-3' }),
    ],
  };
}

function glossarySection(glossary, accent) {
  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, outlineLevel: 0, spacing: { before: 120, after: 120 }, children: [new TextRun({ text: 'Glossary', bold: true, font: SANS, color: accent, size: 48 })] }),
    new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: 'Key terms used throughout this book. Each is footnoted on first use in a chapter.', italics: true, font: SERIF, color: SUBTLE, size: 22 })] }),
  ];
  for (const g of glossary) {
    children.push(new Paragraph({ spacing: { after: 100, line: 290 }, children: [
      new TextRun({ text: `${g.term}.  `, bold: true, font: SANS, color: accent, size: 22 }),
      // Render the definition's inline markdown (code, bold, italics) properly
      // instead of dumping raw backticks and asterisks into the page.
      ...inlineMd(g.def, accent, { size: 22 }),
    ] }));
  }
  return { properties: { type: SectionType.ODD_PAGE, page: PAGE }, footers: { default: pageFooter() }, children };
}

function indexSection(accent) {
  return {
    properties: { type: SectionType.ODD_PAGE, page: PAGE },
    footers: { default: pageFooter() },
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, outlineLevel: 0, spacing: { before: 120, after: 160 }, children: [new TextRun({ text: 'Index', bold: true, font: SANS, color: accent, size: 48 })] }),
      new Paragraph({ children: [new TextRun({ text: 'Key terms and the pages where they appear.', italics: true, font: SERIF, color: SUBTLE, size: 18 })] }),
      new Paragraph({ children: [new SimpleField('INDEX \\h "A" \\c "2"')] }),
    ],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const appArg = (args.find((a) => a.startsWith('--app=')) || '').split('=')[1] || null;
  const wantPdf = args.includes('--pdf');

  const manual = JSON.parse(fs.readFileSync(MANUAL, 'utf8'));
  const chapters = appArg ? manual.filter((c) => c.app === appArg) : manual;
  if (!chapters.length) { console.error(`No chapter for --app=${appArg}`); process.exit(1); }

  const fnState = { reg: {}, next: 1 };
  const allGloss = [];
  const answerKeys = [];
  const chapterSecs = chapters.map((c, i) => {
    const num = appArg ? (manual.findIndex((m) => m.app === c.app) + 1) : i + 1;
    const gloss = parseGlossary(c.markdown);
    allGloss.push(...gloss);
    const enh = loadEnh(c.app);
    // The Introduction chapter is a suite overview, not an app lesson: it never
    // gets a quiz or an answer-key entry, regardless of any enhancement file.
    if (c.app === 'introduction') enh.quiz = [];
    if (Array.isArray(enh.quiz) && enh.quiz.length) answerKeys.push({ num, app: c.app, title: c.title, quiz: enh.quiz });
    return chapterSection(c, num, buildCtx(gloss, fnState), enh);
  });
  const seen = new Set();
  const glossary = [];
  for (const g of allGloss) { const k = g.term.toLowerCase(); if (!seen.has(k)) { seen.add(k); glossary.push(g); } }
  glossary.sort((x, y) => x.term.localeCompare(y.term));

  // Order: front matter, chapters, then the Answer Key appendix, glossary, index.
  const sections = [titleSection(!!appArg), tocSection(), ...chapterSecs];
  if (answerKeys.length) sections.push(answerKeySection(answerKeys, '2563EB'));
  sections.push(glossarySection(glossary, '2563EB'), indexSection('2563EB'));

  const doc = new Document({
    creator: 'BigBlueBam', title: 'BigBlueBam Manual',
    features: { updateFields: true },
    ...(Object.keys(fnState.reg).length ? { footnotes: fnState.reg } : {}),
    styles: { default: { document: { run: { font: SERIF, size: 22, color: INK } } } },
    sections,
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = appArg ? `BigBlueBam-${titleName(appArg, chapters[0].title)}-sample` : 'BigBlueBam-Manual';
  const docxPath = path.join(OUT_DIR, `${base}.docx`);
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buf);
  console.log(`DOCX -> ${path.relative(ROOT, docxPath)}  (${(buf.length / 1024).toFixed(0)} KB)`);

  // Sidecar list of index terms (the glossary terms). The PDF converter marks
  // their occurrences and builds a native alphabetical index, because Word
  // XE/INDEX fields do not survive the LibreOffice import.
  const termsPath = path.join(OUT_DIR, `${base}.terms.json`);
  fs.writeFileSync(termsPath, JSON.stringify(glossary.map((g) => g.term)));

  if (wantPdf) {
    const pdfPath = docxPath.replace(/\.docx$/, '.pdf');
    try { fs.rmSync(pdfPath, { force: true }); } catch {}
    const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
    const killStale = () => {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/F', '/IM', 'soffice.exe', '/T'], { stdio: 'ignore' });
        spawnSync('taskkill', ['/F', '/IM', 'soffice.bin', '/T'], { stdio: 'ignore' });
      } else { spawnSync('pkill', ['-f', 'soffice'], { stdio: 'ignore' }); }
    };
    killStale(); sleep(2000); // officehelper bootstraps its own LibreOffice; clear any stray instance first
    // Convert via UNO so the TOC and Index FIELDS get updated (plain
    // `soffice --convert-to pdf` leaves them blank). Fall back to plain convert
    // only if the LibreOffice python is missing.
    const loPy = process.platform === 'win32' ? 'C:\\Program Files\\LibreOffice\\program\\python.exe' : 'python3';
    const conv = path.join(__dirname, 'lo-convert.py');
    let ok = false;
    if (process.platform !== 'win32' || fs.existsSync(loPy)) {
      const r = spawnSync(loPy, [conv, docxPath, pdfPath, termsPath], { stdio: 'inherit' });
      ok = r.status === 0 && fs.existsSync(pdfPath);
    }
    if (!ok) {
      console.error('UNO convert unavailable; falling back to plain convert (TOC/Index will be blank until opened).');
      killStale(); sleep(3000);
      const soffice = process.platform === 'win32' ? 'C:\\Program Files\\LibreOffice\\program\\soffice.exe' : 'soffice';
      const r2 = spawnSync(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', OUT_DIR, docxPath], { stdio: 'inherit' });
      ok = r2.status === 0 && fs.existsSync(pdfPath);
    }
    if (ok) console.log(`PDF  -> ${path.relative(ROOT, pdfPath)}`);
    else console.error('PDF conversion failed. Close LibreOffice and re-run.');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
