// Minimal YAML emitter for the subset of compose syntax we need:
//   - top-level mapping ({ services: {...} })
//   - nested mappings (service blocks)
//   - lists of strings (volumes, command)
//   - scalar strings, numbers, booleans
//   - literal block scalars for multi-line shell scripts (triggered by an
//     embedded `\n` in a string used as a list element)
//
// Avoids a runtime dep on js-yaml. Not a full YAML implementation —
// strictly what we emit. Inputs are JS objects produced by template.mjs.

const RESERVED_KEY_CHARS = /[:#&*!|>'"%@`{}[\],?]/;

function needsQuoting(s) {
  if (s === '') return true;
  if (/^\s|\s$/.test(s)) return true;
  if (RESERVED_KEY_CHARS.test(s)) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  return false;
}

function quoteScalar(s) {
  // Use double-quoted with simple escapes. Backslash and double-quote only.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function emitScalar(value) {
  if (value === null || value === undefined) return '~';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    return needsQuoting(value) ? quoteScalar(value) : value;
  }
  throw new Error(`Unsupported scalar: ${typeof value}`);
}

function emit(value, indent) {
  const pad = ' '.repeat(indent);

  if (value === null || value === undefined ||
      typeof value === 'boolean' || typeof value === 'number') {
    return emitScalar(value);
  }

  if (typeof value === 'string') {
    // Multi-line literal block scalar — chomping default (clip).
    if (value.includes('\n')) {
      const lines = value.split('\n');
      const inner = lines.map((line) => `${pad}  ${line}`).join('\n');
      return `|\n${inner}`;
    }
    return emitScalar(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const lines = value.map((item) => {
      if (typeof item === 'string' && item.includes('\n')) {
        // List item is a multi-line string — emit as `- |` block.
        const innerLines = item.split('\n');
        const inner = innerLines.map((line) => `${pad}    ${line}`).join('\n');
        return `${pad}- |\n${inner}`;
      }
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        // List of mappings: `- key: ...` for first key, then aligned children.
        const entries = Object.entries(item);
        if (entries.length === 0) return `${pad}- {}`;
        const [firstK, firstV] = entries[0];
        const firstLine = `${pad}- ${firstK}: ${emit(firstV, indent + 2)}`;
        const rest = entries.slice(1).map(
          ([k, v]) => `${pad}  ${k}: ${emit(v, indent + 2)}`,
        );
        return [firstLine, ...rest].join('\n');
      }
      return `${pad}- ${emit(item, indent + 2)}`;
    });
    return '\n' + lines.join('\n');
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const lines = entries.map(([k, v]) => {
      const keyStr = needsQuoting(k) ? quoteScalar(k) : k;
      if (v === null || v === undefined ||
          typeof v === 'boolean' || typeof v === 'number') {
        return `${pad}${keyStr}: ${emitScalar(v)}`;
      }
      if (typeof v === 'string') {
        if (v.includes('\n')) {
          return `${pad}${keyStr}: ${emit(v, indent)}`;
        }
        return `${pad}${keyStr}: ${emitScalar(v)}`;
      }
      if (Array.isArray(v)) {
        if (v.length === 0) return `${pad}${keyStr}: []`;
        return `${pad}${keyStr}:${emit(v, indent)}`;
      }
      // nested mapping — newline + indented children
      const nested = emit(v, indent + 2);
      if (nested === '{}') return `${pad}${keyStr}: {}`;
      return `${pad}${keyStr}:\n${nested}`;
    });
    return lines.join('\n');
  }

  throw new Error(`Unsupported value: ${typeof value}`);
}

/**
 * Emit a JS object as a YAML document string. Always ends with a single
 * trailing newline.
 */
export function emitYaml(obj) {
  return emit(obj, 0) + '\n';
}

/**
 * Parse a small subset of YAML — enough to read back our own output to
 * extract service names from an existing override file. Only handles:
 *   - top-level `services:` mapping
 *   - direct child keys of services as service names
 * Returns { services: [...] } or { services: [] } if absent.
 *
 * Rationale: we never need to round-trip user-edited override files — if
 * the user hand-edits, they can use `clear` and recreate. We only need to
 * answer `list overridden` and `remove <svc>` questions, which only need
 * the service name set + the ability to omit one and rewrite.
 */
export function parseOverrideServices(text) {
  const lines = text.split('\n');
  let inServices = false;
  const services = [];
  for (const raw of lines) {
    if (raw.startsWith('#') || raw.trim() === '') continue;
    if (/^services:\s*$/.test(raw)) {
      inServices = true;
      continue;
    }
    if (inServices) {
      // A service entry is `  <name>:` at exactly 2-space indent.
      const m = raw.match(/^  ([A-Za-z0-9_-]+):\s*$/);
      if (m) {
        services.push(m[1]);
        continue;
      }
      // If we hit a top-level key (no leading spaces) other than services,
      // we've left the services block.
      if (/^[A-Za-z]/.test(raw)) {
        inServices = false;
      }
    }
  }
  return { services };
}
