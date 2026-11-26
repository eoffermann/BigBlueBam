// #276: docker-compose.yml is also the production Compose deploy, so any host port it publishes
// listens on every interface of a self-hosted server. Only the genuine edges may do that; every
// other published port (developer conveniences such as mcp-server :3001, mailhog, the dev and
// multi overlays) must be bound to 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Services that ARE the edge: nginx (frontend 80/443), the marketing site (serves itself on its own
// port/domain, not behind nginx), and LiveKit (WebRTC signalling and media must reach clients).
const EDGE_SERVICES = new Set(['frontend', 'site', 'livekit']);

/** [{ file, service, mapping }] for every `ports:` entry in every compose file. */
function publishedPorts() {
  const out = [];
  for (const file of readdirSync(ROOT).filter((f) => /^docker-compose.*\.ya?ml$/.test(f))) {
    let service = null;
    let inPorts = false;
    for (const line of readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/)) {
      const svc = /^ {2}([a-z0-9][a-z0-9_-]*):\s*$/.exec(line);
      if (svc) {
        service = svc[1];
        inPorts = false;
        continue;
      }
      if (/^ {4}ports:\s*$/.test(line)) {
        inPorts = true;
        continue;
      }
      if (inPorts) {
        if (/^\s*#/.test(line) || line.trim() === '') continue;
        const item = /^ {6}-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
        if (item) out.push({ file, service, mapping: item[1].trim() });
        else inPorts = false;
      }
    }
  }
  return out;
}

test('the scan sees the known mappings', () => {
  const ports = publishedPorts();
  assert.ok(ports.some((p) => p.service === 'mcp-server'), 'mcp-server mapping found');
  assert.ok(ports.some((p) => p.service === 'frontend'), 'frontend mapping found');
});

test('every non-edge published port is bound to 127.0.0.1', () => {
  const open = publishedPorts()
    .filter((p) => !EDGE_SERVICES.has(p.service))
    .filter((p) => !p.mapping.startsWith('127.0.0.1:'))
    .map((p) => `${p.file} ${p.service}: ${p.mapping}`);
  assert.deepEqual(open, [], `bind these to 127.0.0.1 or add the service to EDGE_SERVICES with a reason:\n${open.join('\n')}`);
});
