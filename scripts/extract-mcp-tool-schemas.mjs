#!/usr/bin/env node
/**
 * extract-mcp-tool-schemas.mjs
 *
 * Parses every apps/mcp-server/src/tools/*-tools.ts file and extracts each
 * `registerTool(server, { name, description, input: { ...zod schema } })`
 * registration (and the legacy `server.tool('name', 'desc', {...}, handler)`
 * form) so
 * the Bolt action editor can present a typed parameter picker instead of
 * forcing users to free-type MCP arguments.
 *
 * Output: apps/bolt-api/src/services/mcp-tool-schemas.generated.ts (checked in).
 *
 *   node scripts/extract-mcp-tool-schemas.mjs --write   # regenerate the file
 *   node scripts/extract-mcp-tool-schemas.mjs --check   # exit 1 if the committed
 *                                                       # file is stale (CI, issue #147)
 *   node scripts/extract-mcp-tool-schemas.mjs           # print to stdout
 *
 * Prefer --write over a shell redirect: Windows PowerShell redirects as UTF-16.
 * Every mode fails when a *-tools.ts file that registers tools yields zero
 * extracted tools (the silent parser gap fixed in 696d25dd).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBoltSources } from './lib/bolt-sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, 'apps/mcp-server/src/tools');

// Shared constants a tool schema may pass to z.enum(...) by name. Each maps to
// a loader that reads the canonical list from source, so the generated schema
// carries the real values instead of an empty enum.
const SHARED_ENUM_CONSTANTS = {
  BOLT_SOURCES: () => loadBoltSources(),
};

// `const NAME = ['a', 'b'] as const` declarations in the tool file currently
// being parsed, so z.enum(NAME) resolves to its values.
let currentFileConstants = new Map();

function collectFileConstants(source) {
  const out = new Map();
  const re = /const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const values = [...m[2].matchAll(/['"`]([^'"`]+)['"`]/g)].map((v) => v[1]);
    if (values.length) out.set(m[1], values);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Brace-balanced extraction
// ---------------------------------------------------------------------------

/**
 * Find every server.tool(...) invocation in the file and return the raw text
 * of the third argument (the zod schema object).
 */
function extractToolBlocks(rawSource) {
  const source = stripComments(rawSource);
  const blocks = extractRegisterToolBlocks(source);
  const re = /server\.tool\(\s*/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const start = match.index + match[0].length;
    // Parse arg 1: tool name (string literal)
    const arg1 = parseStringLiteral(source, start);
    if (!arg1) continue;
    // Skip whitespace + comma
    let i = arg1.end;
    i = skipWsAndComma(source, i);
    // Parse arg 2: description (string literal — may be template literal or multi-line)
    const arg2 = parseStringLiteral(source, i);
    if (!arg2) continue;
    i = skipWsAndComma(source, arg2.end);
    // Parse arg 3: object literal { ... } — track brace depth
    if (source[i] !== '{') continue;
    const obj = readBalancedBlock(source, i, '{', '}');
    blocks.push({
      name: arg1.value,
      description: arg2.value,
      schemaText: source.slice(obj.start + 1, obj.end - 1),
    });
  }
  return blocks;
}

/**
 * Remove // and /* *\/ comments while respecting string and template literals,
 * so an apostrophe in a comment cannot desynchronize the brace scanner.
 */
function stripComments(source) {
  let out = '';
  let inString = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += source[i + 1] ?? ''; i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; out += c; continue; }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Parse a run of string literals joined by `+` (descriptions are often split
 * across lines that way). Returns the concatenated value or null.
 */
function parseConcatenatedString(text) {
  let i = 0;
  let value = '';
  let any = false;
  while (i < text.length) {
    const lit = parseStringLiteral(text, i);
    if (!lit) return null;
    value += lit.value;
    any = true;
    i = lit.end;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] !== '+') return null;
    i++;
  }
  return any ? value : null;
}

/**
 * Find every `registerTool(server, { name, description, input: {...}, ... })`
 * call (the current registration form; see apps/mcp-server/src/lib/register-tool.ts).
 */
function extractRegisterToolBlocks(source) {
  const blocks = [];
  const re = /registerTool\(\s*server\s*,\s*/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const start = match.index + match[0].length;
    if (source[start] !== '{') continue;
    const obj = readBalancedBlock(source, start, '{', '}');
    const props = splitTopLevelCommas(source.slice(obj.start + 1, obj.end - 1));
    let name;
    let description = '';
    let schemaText = '';
    for (const prop of props) {
      const colon = findUnquotedColon(prop);
      if (colon < 0) continue;
      const key = prop.slice(0, colon).trim();
      const value = prop.slice(colon + 1).trim();
      if (key === 'name') name = parseConcatenatedString(value) ?? undefined;
      else if (key === 'description') description = parseConcatenatedString(value) ?? '';
      else if (key === 'input' && value.startsWith('{')) {
        const inner = readBalancedBlock(value, 0, '{', '}');
        schemaText = value.slice(inner.start + 1, inner.end - 1);
      }
    }
    if (name) blocks.push({ name, description, schemaText });
  }
  return blocks;
}

function parseStringLiteral(source, start) {
  let i = start;
  while (i < source.length && /\s/.test(source[i])) i++;
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let j = i + 1;
  let value = '';
  while (j < source.length) {
    const c = source[j];
    if (c === '\\') { value += source[j + 1]; j += 2; continue; }
    if (c === quote) return { value, end: j + 1 };
    value += c;
    j++;
  }
  return null;
}

function skipWsAndComma(source, start) {
  let i = start;
  while (i < source.length && /[\s,]/.test(source[i])) i++;
  return i;
}

function readBalancedBlock(source, start, open, close) {
  let depth = 0;
  let inString = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  throw new Error(`Unbalanced ${open}${close} starting at ${start}`);
}

// ---------------------------------------------------------------------------
// Schema parsing
// ---------------------------------------------------------------------------

/**
 * Split a comma-separated parameter list at depth 0, ignoring commas inside
 * nested ()/{}/[] groups and string literals. Each fragment is "key: zod-expr".
 */
function splitTopLevelCommas(text) {
  const out = [];
  let depth = 0;
  let inString = null;
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      buf += c;
      if (c === '\\') { buf += text[i + 1]; i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; buf += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = '';
      continue;
    }
    buf += c;
  }
  const t = buf.trim();
  if (t) out.push(t);
  return out;
}

function parseParameter(line) {
  // line looks like "name: z.string().describe('...')" or "name: z.array(z.string()).optional()"
  // Split off the key
  const colonIdx = findUnquotedColon(line);
  if (colonIdx < 0) return null;
  const rawKey = line.slice(0, colonIdx).trim();
  // Strip surrounding quotes if present
  const key = rawKey.replace(/^['"]|['"]$/g, '');
  // Fold chained calls written one per line (`z\n  .string()\n  .uuid()`) onto one line.
  const expr = line.slice(colonIdx + 1).trim().replace(/\s*\n\s*\./g, '.');
  if (!expr.startsWith('z.')) return null;

  const optional = /\.optional\(\)/.test(expr);
  const nullable = /\.nullable\(\)/.test(expr);

  // Type detection — first z.<head>(...) call
  const headMatch = expr.match(/^z\.(\w+)\s*\(([^)]*)\)/);
  if (!headMatch) return null;
  const head = headMatch[1];
  const headArgs = headMatch[2];

  let type;
  let enumValues;
  let format;
  switch (head) {
    case 'string':
      type = 'string';
      if (/\.uuid\(\)/.test(expr)) format = 'uuid';
      else if (/\.email\(\)/.test(expr)) format = 'email';
      else if (/\.url\(\)/.test(expr)) format = 'url';
      else if (/\.datetime\(\)/.test(expr)) format = 'datetime';
      break;
    case 'number':
      type = 'number';
      if (/\.int\(\)/.test(expr)) format = 'integer';
      break;
    case 'boolean':
      type = 'boolean';
      break;
    case 'array':
      type = 'array';
      // Try to detect element type from arg
      if (/z\.string\(\)/.test(headArgs)) format = 'string[]';
      else if (/z\.number\(\)/.test(headArgs)) format = 'number[]';
      else if (/uuid/.test(headArgs)) format = 'uuid[]';
      break;
    case 'enum': {
      type = 'enum';
      // Parse the enum values inline — array of string literals
      const enumMatch = expr.match(/z\.enum\(\s*\[([^\]]*)\]/);
      if (enumMatch) {
        enumValues = enumMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
          .filter(Boolean);
      } else {
        // z.enum(SHARED_CONST): resolve shared constants by name (issue #138).
        const constMatch = expr.match(/z\.enum\(\s*([A-Z][A-Z0-9_]*)\s*[,)]/);
        if (constMatch) {
          // Same-file `const NAME = [...]` first, then the shared constants.
          const local = currentFileConstants.get(constMatch[1]);
          const resolver = SHARED_ENUM_CONSTANTS[constMatch[1]];
          if (local) enumValues = local;
          else if (resolver) enumValues = resolver();
        }
      }
      break;
    }
    case 'object':
      type = 'object';
      break;
    case 'record':
      type = 'object';
      break;
    case 'literal':
      type = 'string';
      break;
    case 'union':
      type = 'union';
      break;
    case 'any':
    case 'unknown':
      type = 'any';
      break;
    default:
      type = head;
  }

  // Description — last .describe('...') call
  let description = '';
  const descMatch = expr.match(/\.describe\(\s*['"`]((?:[^'"`\\]|\\.)*)['"`]\s*\)/);
  if (descMatch) {
    description = descMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
  }

  return {
    name: key,
    type,
    format,
    enum: enumValues,
    required: !optional,
    nullable,
    description,
  };
}

function findUnquotedColon(text) {
  let inString = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ':' && depth === 0) return i;
  }
  return -1;
}

function parseSchema(schemaText) {
  const lines = splitTopLevelCommas(schemaText);
  const params = [];
  for (const line of lines) {
    const p = parseParameter(line);
    if (p) params.push(p);
  }
  return params;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function deriveSourceFromFilename(filename) {
  // Map "task-tools.ts" → "bam" (Bam tools live in many files)
  // Use the convention: file stem before "-tools" is the source, with a few
  // overrides for the Bam-aggregated files.
  const stem = filename.replace(/-tools\.ts$/, '');
  const bamStems = new Set([
    'task', 'sprint', 'project', 'comment', 'member', 'report',
    'template', 'import', 'utility', 'me', 'platform',
  ]);
  if (bamStems.has(stem)) return 'bam';
  return stem;
}

const OUT_FILE = join(ROOT, 'apps/bolt-api/src/services/mcp-tool-schemas.generated.ts');
const writeMode = process.argv.includes('--write');
const checkMode = process.argv.includes('--check');

const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('-tools.ts'));
const allTools = [];
const emptyFiles = [];

for (const file of files.sort()) {
  const source = readFileSync(join(TOOLS_DIR, file), 'utf8');
  currentFileConstants = collectFileConstants(stripComments(source));
  const blocks = extractToolBlocks(source);
  if (blocks.length === 0 && /registerTool\(|server\.tool\(/.test(stripComments(source))) {
    emptyFiles.push(file);
  }
  const sourceName = deriveSourceFromFilename(file);
  for (const block of blocks) {
    const params = parseSchema(block.schemaText);
    allTools.push({
      mcp_tool: block.name,
      description: block.description,
      source: sourceName,
      parameters: params,
    });
  }
}

// Sort: by source, then by tool name
allTools.sort((a, b) => {
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  return a.mcp_tool.localeCompare(b.mcp_tool);
});

// Emit a TypeScript module so the bolt-api can import it directly without
// runtime JSON parsing or extra build configuration.
const header = `// AUTO-GENERATED by scripts/extract-mcp-tool-schemas.mjs. Do not edit by hand.
// Re-run the script whenever an MCP tool schema changes (CI runs --check):
//   pnpm mcp-tool-schemas:generate

export interface McpToolParameter {
  name: string;
  type: string;
  format?: string;
  enum?: string[];
  required: boolean;
  nullable: boolean;
  description: string;
}

export interface McpToolSchema {
  mcp_tool: string;
  description: string;
  source: string;
  parameters: McpToolParameter[];
}

export const MCP_TOOL_SCHEMAS: McpToolSchema[] = `;

const output = `${header}${JSON.stringify(allTools, null, 2)};\n`;

if (emptyFiles.length) {
  console.error('FAIL: these tool modules register tools but the extractor found none:');
  for (const f of emptyFiles) console.error(`  apps/mcp-server/src/tools/${f}`);
  console.error('Teach scripts/extract-mcp-tool-schemas.mjs the registration form they use.');
  process.exit(1);
}

if (checkMode) {
  // A Windows autocrlf checkout stores the file as CRLF while we emit LF.
  const committed = readFileSync(OUT_FILE, 'utf8').replace(/\r\n/g, '\n');
  if (committed !== output) {
    const committedCount = (committed.match(/"mcp_tool":/g) ?? []).length;
    console.error(
      `FAIL: ${OUT_FILE} is stale (committed: ${committedCount} tools, fresh run: ${allTools.length} tools).`,
    );
    console.error('Regenerate it with: pnpm mcp-tool-schemas:generate, then commit the result.');
    process.exit(1);
  }
  console.log(`OK: mcp-tool-schemas.generated.ts is current (${allTools.length} tools from ${files.length} modules).`);
} else if (writeMode) {
  writeFileSync(OUT_FILE, output);
  console.log(`wrote ${OUT_FILE} (${allTools.length} tools from ${files.length} modules)`);
} else {
  process.stdout.write(output);
}
