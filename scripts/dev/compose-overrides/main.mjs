#!/usr/bin/env node
//
// compose-overrides/main.mjs — CLI for managing docker-compose.override.yml
// for active local-Docker dev work on individual services.
//
// Subcommands:
//   list [overridden|available]   — what's overridden now / what can be added
//   add <service>                 — add or replace a service block
//   remove <service>              — remove a service block (delete file if empty)
//   clear                         — delete the override file
//   show                          — cat the override file
//   help                          — usage
//
// Default state is "no override file present" → compose runs the prod stack
// everywhere. Adding a service generates a block that runs the prod
// Dockerfile's `deps` stage with bind-mounted source + tsup-watch + node
// --watch, so dev and prod use the same `node dist/<entry>.js` runtime.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bold, dim, green, red, cyan, yellow } from '../../deploy/shared/colors.mjs';
import { assertRepoRoot } from '../../lib/preflight.mjs';
import { emitYaml, parseOverrideServices } from './yaml.mjs';
import {
  classifyService,
  listAllServices,
  generateNodeServiceBlock,
  generateViteFrontendDevBuilder,
  generateFrontendOverlayForVite,
} from './template.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
process.chdir(repoRoot);
assertRepoRoot();

const OVERRIDE_FILE = 'docker-compose.override.yml';
const OVERRIDE_HEADER = `# docker-compose.override.yml — gitignored, per-developer dev overrides.
# Managed by scripts/dev/compose-overrides.sh. Do not hand-edit unless you
# accept that this file may be rewritten on the next 'add' or 'remove'.
# Use './scripts/dev/compose-overrides.sh clear' to wipe entirely.

`;

// State model: the set of services the USER has added (e.g., `banter`,
// `api`), per kind. Everything emitted to docker-compose.override.yml is
// regenerated from this each write, so user-perspective names never have
// to round-trip through the file's actual block names (which include
// `<spa>-dev-builder` sidecars + a synthesized `frontend` overlay).
function readOverride() {
  if (!fs.existsSync(OVERRIDE_FILE)) {
    return { nodeNames: new Set(), viteNames: new Set() };
  }
  const text = fs.readFileSync(OVERRIDE_FILE, 'utf8');
  const { services } = parseOverrideServices(text);
  const nodeNames = new Set();
  const viteNames = new Set();
  for (const blockName of services) {
    if (blockName.endsWith('-dev-builder')) {
      const spa = blockName.slice(0, -'-dev-builder'.length);
      const cls = classifyService(spa, repoRoot);
      if (cls.kind === 'vite-frontend') viteNames.add(spa);
      // else: silently drop on rewrite.
      continue;
    }
    if (blockName === 'frontend') {
      // Synthesized from viteNames; recoverable from the dev-builder siblings.
      continue;
    }
    const cls = classifyService(blockName, repoRoot);
    if (cls.kind === 'node') nodeNames.add(blockName);
    // else: silently drop on rewrite.
  }
  return { nodeNames, viteNames };
}

function buildOverrideServices({ nodeNames, viteNames }) {
  const services = {};
  for (const name of [...nodeNames].sort()) {
    services[name] = generateNodeServiceBlock(name, repoRoot);
  }
  const viteList = [...viteNames].sort();
  for (const name of viteList) {
    services[`${name}-dev-builder`] = generateViteFrontendDevBuilder(name, repoRoot);
  }
  if (viteList.length > 0) {
    services.frontend = generateFrontendOverlayForVite(viteList, repoRoot);
  }
  return services;
}

function writeOverride(state) {
  if (state.nodeNames.size === 0 && state.viteNames.size === 0) {
    if (fs.existsSync(OVERRIDE_FILE)) fs.unlinkSync(OVERRIDE_FILE);
    return;
  }
  const services = buildOverrideServices(state);
  const yaml = emitYaml({ services });
  fs.writeFileSync(OVERRIDE_FILE, OVERRIDE_HEADER + yaml, { encoding: 'utf8' });
}

function refusalMessage(name, classification) {
  if (classification.kind === 'python') {
    return [
      `${red('[refused]')} ${cyan(name)} is a Python service (uvicorn FastAPI + LiveKit Agents SDK).`,
      '',
      `  Its dev iteration would use ${cyan('uvicorn --reload')}, not the tsup→node pattern.`,
      `  ${dim('Python dev support is a planned extension — separate template needed.')}`,
      '',
    ].join('\n');
  }
  // unknown
  const all = listAllServices(repoRoot);
  const supported = all
    .filter((s) => s.kind === 'node' || s.kind === 'vite-frontend')
    .map((s) => s.name)
    .join(', ');
  return [
    `${red('[refused]')} ${cyan(name)} is not a recognized service.`,
    '',
    '  Supported services today:',
    `    ${supported}`,
    '',
    `  ${dim("Run './scripts/dev/compose-overrides.sh list available' for a full classification.")}`,
    '',
  ].join('\n');
}

function cmdHelp() {
  console.log(`${bold('compose-overrides')} — manage per-service dev overrides

${bold('USAGE')}
  ./scripts/dev/compose-overrides.sh <subcommand> [args]

${bold('SUBCOMMANDS')}
  ${cyan('list')} [overridden|available]
      ${dim('overridden (default): services currently in dev-watch mode')}
      ${dim('available: every service known to apps/, with classification')}

  ${cyan('add')} <service>
      ${dim('Add or replace the service\'s block in docker-compose.override.yml.')}
      ${dim('Node services run tsup→node --watch; Vite SPAs spawn a')}
      ${dim('<spa>-dev-builder sidecar (vite build --watch). Python and other')}
      ${dim('kinds are refused with a targeted message.')}

  ${cyan('remove')} <service>
      ${dim('Remove the service\'s block. If the override file becomes empty,')}
      ${dim('the file is deleted entirely.')}

  ${cyan('clear')}
      ${dim('Delete docker-compose.override.yml outright.')}

  ${cyan('show')}
      ${dim('cat the override file (or print "(no override active)" if absent).')}

  ${cyan('help')}
      ${dim('this message')}

${bold('NEXT STEP')} after add/remove
  ${cyan('node scripts/dev/up.mjs')} ${dim('(or VS Code → Tasks: Run Task → "Dev: Up")')}
  ${dim('docker compose up -d --build <service>  — picks up the override change')}
`);
}

function cmdListOverridden() {
  const state = readOverride();
  if (state.nodeNames.size === 0 && state.viteNames.size === 0) {
    console.log(dim('(no override active)'));
    return;
  }
  for (const name of [...state.nodeNames].sort()) {
    console.log(`  ${cyan(name)} ${dim('(node tsup→node)')}`);
  }
  for (const name of [...state.viteNames].sort()) {
    console.log(`  ${cyan(name)} ${dim('(vite build --watch)')}`);
  }
}

function cmdListAvailable() {
  const all = listAllServices(repoRoot);
  const grouped = {};
  for (const s of all) (grouped[s.kind] ||= []).push(s.name);

  const nodeSet = (grouped.node || []);
  const viteSet = (grouped['vite-frontend'] || []);
  const pythonSet = (grouped.python || []);
  const unknownSet = (grouped.unknown || []);

  console.log(`${bold('SUPPORTED')} ${dim('(can be added today)')}`);
  for (const name of nodeSet) {
    console.log(`  ${green('✓')} ${cyan(name)} ${dim('(node tsup→node)')}`);
  }
  for (const name of viteSet) {
    console.log(`  ${green('✓')} ${cyan(name)} ${dim('(vite build --watch)')}`);
  }

  if (pythonSet.length > 0) {
    console.log('');
    console.log(`${bold('NOT YET SUPPORTED — Python')} ${dim('(planned: uvicorn --reload)')}`);
    for (const name of pythonSet) {
      console.log(`  ${yellow('·')} ${dim(name)}`);
    }
  }

  if (unknownSet.length > 0) {
    console.log('');
    console.log(`${bold('NOT APPLICABLE')} ${dim('(test/tooling packages, not deployed services)')}`);
    for (const name of unknownSet) {
      console.log(`  ${dim('-')} ${dim(name)}`);
    }
  }
}

function cmdList(args) {
  const which = args[0] || 'overridden';
  if (which === 'overridden') return cmdListOverridden();
  if (which === 'available') return cmdListAvailable();
  console.error(red(`[fail] Unknown list mode: ${which}. Use 'overridden' or 'available'.`));
  process.exit(1);
}

function cmdAdd(args) {
  const name = args[0];
  if (!name) {
    console.error(red('[fail] add requires a service name. Try `list available` first.'));
    process.exit(1);
  }
  const cls = classifyService(name, repoRoot);
  if (cls.kind !== 'node' && cls.kind !== 'vite-frontend') {
    console.error(refusalMessage(name, cls));
    process.exit(1);
  }
  const state = readOverride();
  const set = cls.kind === 'node' ? state.nodeNames : state.viteNames;
  const wasReplacement = set.has(name);
  set.add(name);
  writeOverride(state);
  const verb = wasReplacement ? 'replaced' : 'added';
  console.log(`${green('[ok]')} ${verb} ${cyan(name)} in ${cyan(OVERRIDE_FILE)}.`);
  console.log('');
  if (cls.kind === 'vite-frontend') {
    console.log(`  Next: ${cyan(`docker compose up -d --build frontend ${name}-dev-builder`)}`);
    console.log(`        ${dim('(or VS Code → Tasks: Run Task → "Dev: Up")')}`);
  } else {
    console.log(`  Next: ${cyan(`docker compose up -d --build ${name}`)}`);
    console.log(`        ${dim('(or VS Code → Tasks: Run Task → "Dev: Up")')}`);
  }
}

function cmdRemove(args) {
  const name = args[0];
  if (!name) {
    console.error(red('[fail] remove requires a service name.'));
    process.exit(1);
  }
  if (!fs.existsSync(OVERRIDE_FILE)) {
    console.log(dim('(no override active — nothing to remove)'));
    return;
  }
  const state = readOverride();
  const inNode = state.nodeNames.has(name);
  const inVite = state.viteNames.has(name);
  if (!inNode && !inVite) {
    console.log(dim(`(${name} is not currently overridden)`));
    return;
  }
  if (inNode) state.nodeNames.delete(name);
  if (inVite) state.viteNames.delete(name);
  writeOverride(state);
  const remaining = state.nodeNames.size + state.viteNames.size;
  if (remaining === 0) {
    console.log(`${green('[ok]')} removed ${cyan(name)}; override file deleted (was the only entry).`);
  } else {
    console.log(`${green('[ok]')} removed ${cyan(name)} from ${cyan(OVERRIDE_FILE)}.`);
  }
  console.log('');
  if (inVite) {
    console.log(`  Next: ${cyan('docker compose up -d --force-recreate frontend')}`);
    console.log(`        ${dim(`(reverts ${name} to baked-in dist)`)}`);
  } else {
    console.log(`  Next: ${cyan(`docker compose up -d ${name}`)}`);
    console.log(`        ${dim('(reverts the service to its prod image)')}`);
  }
}

function cmdClear() {
  if (!fs.existsSync(OVERRIDE_FILE)) {
    console.log(dim('(no override active — nothing to clear)'));
    return;
  }
  fs.unlinkSync(OVERRIDE_FILE);
  console.log(`${green('[ok]')} deleted ${cyan(OVERRIDE_FILE)}.`);
  console.log('');
  console.log(`  Next: ${cyan('docker compose up -d')}`);
  console.log(`        ${dim('(brings every service back to its prod image)')}`);
}

function cmdShow() {
  if (!fs.existsSync(OVERRIDE_FILE)) {
    console.log(dim('(no override active)'));
    return;
  }
  process.stdout.write(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
}

const [subcommand, ...rest] = process.argv.slice(2);

switch (subcommand) {
  case undefined:
  case 'help':
  case '-h':
  case '--help':
    cmdHelp();
    break;
  case 'list':
    cmdList(rest);
    break;
  case 'add':
    cmdAdd(rest);
    break;
  case 'remove':
    cmdRemove(rest);
    break;
  case 'clear':
    cmdClear();
    break;
  case 'show':
    cmdShow();
    break;
  default:
    console.error(red(`[fail] Unknown subcommand: ${subcommand}`));
    console.error('');
    cmdHelp();
    process.exit(1);
}
