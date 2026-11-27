// #361: the permission-catalog drift guard must not report line-ending-only
// differences (Windows autocrlf checkouts) as drift, and the generated files
// must be pinned to LF in .gitattributes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameArtifactText } from '../check-permission-catalog.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('a CRLF working copy of an LF regenerated artifact is not drift', () => {
  const lf = '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.equal(sameArtifactText(lf, crlf), true);
  assert.equal(sameArtifactText(crlf, lf), true);
});

test('a real content change is still drift, whatever the line endings', () => {
  const lf = 'export const X = 1;\n';
  const changed = 'export const X = 2;\r\n';
  assert.equal(sameArtifactText(lf, changed), false);
  assert.equal(sameArtifactText('a\nb\n', 'a\r\nb\r\nc\r\n'), false);
});

test('.gitattributes pins the generated permission artifacts to LF', () => {
  const attrs = readFileSync(join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attrs, /^docs\/permissions-action-manifest\.json\s+text\s+eol=lf\s*$/m);
  assert.match(attrs, /^packages\/permissions\/src\/generated\/\*\.ts\s+text\s+eol=lf\s*$/m);
});
