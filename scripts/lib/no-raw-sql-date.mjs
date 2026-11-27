// #358: a JS Date interpolated into a raw sql`...` template reaches postgres-js
// as an untyped parameter. drizzle replaces the client's timestamp serializers
// with identity functions, so the Date is never converted and the driver throws
// ERR_INVALID_ARG_TYPE (Bin's scan override returned 500 on every call, #178).
// Pass an ISO string instead (`${d.toISOString()}::timestamptz`) or compare
// through a typed column helper (lt(col, d), gte(col, d), ...).
//
// A grep for `${new Date(` misses the real shapes (multi-line templates, a
// local `const now = new Date()`, `allow ? new Date() : null`), so this scan
// parses every source file with the TypeScript parser (syntax only, no type
// check) and, for each sql-tagged template, flags an interpolated expression
// that is a Date by construction:
//   - `new Date(...)`, including inside ?:, ??, ||, parens, `as`, `!`
//   - an identifier whose declaration in an enclosing scope is initialized with
//     one of the above, or is annotated / typed as Date (`x: Date | null`)
//   - `x.p` where x is annotated with an inline type literal, or an interface /
//     type alias declared in the same file, whose member p is typed Date
// Imported types, inferred row shapes and call results are not resolved; this
// is a syntactic net, not a type checker.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function unwrap(e) {
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e)))
  ) {
    e = e.expression;
  }
  return e;
}

function typeMentionsDate(typeNode) {
  if (!typeNode) return false;
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && n.typeName.text === 'Date') {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(typeNode);
  return found;
}

/** Declarations of `name` visible from `node`, innermost scope first. */
function findDeclaration(node, name) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur) && cur.parameters) {
      for (const p of cur.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return p;
      }
    }
    const statements = ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur) ? cur.statements : null;
    if (statements) {
      for (const st of statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return d;
        }
      }
    }
    if ((ts.isForStatement(cur) || ts.isForOfStatement(cur) || ts.isForInStatement(cur)) && cur.initializer) {
      const init = cur.initializer;
      if (ts.isVariableDeclarationList(init)) {
        for (const d of init.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === name) return d;
        }
      }
    }
  }
  return null;
}

function isDateExpr(expr, seen = new Set()) {
  const e = unwrap(expr);
  if (!e) return false;
  if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'Date') return true;
  if (ts.isConditionalExpression(e)) return isDateExpr(e.whenTrue, seen) || isDateExpr(e.whenFalse, seen);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return isDateExpr(e.right, seen) || (op !== ts.SyntaxKind.AmpersandAmpersandToken && isDateExpr(e.left, seen));
    }
    return false;
  }
  if (ts.isIdentifier(e)) {
    const decl = findDeclaration(e, e.text);
    if (!decl || seen.has(decl)) return false;
    seen.add(decl);
    if (typeMentionsDate(decl.type)) return true;
    if (decl.initializer) return isDateExpr(decl.initializer, seen);
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(unwrap(e.expression))) {
    const base = unwrap(e.expression);
    const decl = findDeclaration(base, base.text);
    const member = decl && memberType(decl.type, e.name.text, e.getSourceFile());
    if (member && typeMentionsDate(member)) return true;
  }
  return false;
}

/** The declared type of member `prop` on a type literal, or on an interface / type alias in this file. */
function memberType(typeNode, prop, sf, depth = 0) {
  if (!typeNode || depth > 3) return null;
  if (ts.isTypeLiteralNode(typeNode)) return findMember(typeNode.members, prop);
  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    for (const t of typeNode.types) {
      const m = memberType(t, prop, sf, depth + 1);
      if (m) return m;
    }
    return null;
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const name = typeNode.typeName.text;
    for (const st of sf.statements) {
      if (ts.isInterfaceDeclaration(st) && st.name.text === name) return findMember(st.members, prop);
      if (ts.isTypeAliasDeclaration(st) && st.name.text === name) return memberType(st.type, prop, sf, depth + 1);
    }
  }
  return null;
}

function findMember(members, prop) {
  for (const m of members) {
    if (ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name) && m.name.text === prop) return m.type;
  }
  return null;
}

function isSqlTag(tag) {
  const t = unwrap(tag);
  return ts.isIdentifier(t) && t.text === 'sql';
}

/** `{ line, text }` for every Date interpolated into a sql`...` template in `source`. */
export function findSqlDatesInSource(source, fileName = 'x.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits = [];
  const visit = (n) => {
    if (ts.isTaggedTemplateExpression(n) && isSqlTag(n.tag) && ts.isTemplateExpression(n.template)) {
      for (const span of n.template.templateSpans) {
        if (isDateExpr(span.expression)) {
          const { line } = sf.getLineAndCharacterOfPosition(span.expression.getStart(sf));
          hits.push({ line: line + 1, text: span.expression.getText(sf) });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/** Every `file:line: ${expr}` under apps/*\/src and packages/*\/src. */
export function findSqlDates(root) {
  const out = [];
  for (const top of ['apps', 'packages']) {
    const base = join(root, top);
    if (!existsSync(base)) continue;
    for (const pkg of readdirSync(base).sort()) {
      const src = join(base, pkg, 'src');
      if (!existsSync(src) || !statSync(src).isDirectory()) continue;
      for (const file of walk(src, []).sort()) {
        const text = readFileSync(file, 'utf8');
        if (!text.includes('sql`') && !text.includes('sql<')) continue;
        for (const h of findSqlDatesInSource(text, file)) {
          out.push(`${relative(root, file).replace(/\\/g, '/')}:${h.line}: \${${h.text}}`);
        }
      }
    }
  }
  return out;
}
