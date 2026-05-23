#!/usr/bin/env node
// Wave D consistency audit. Reads manifest, parses generated TS, calls psql via
// docker compose exec, and emits a structured JSON summary to stdout.
//
// Outputs JSON to stdout; no side effects on source files.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = "D:/Documents/GitHub/BigBlueBam";

function psql(sql) {
  const out = execFileSync(
    "docker",
    [
      "compose",
      "--project-directory",
      REPO,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "bigbluebam",
      "-d",
      "bigbluebam",
      "-A", // unaligned
      "-t", // tuples only
      "-F",
      "\t",
      "-c",
      sql,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out;
}

// ── 1. Load manifest ────────────────────────────────────────────────
const manifestPath = path.join(REPO, "docs/permissions-action-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestPerms = manifest.permissions;
const manifestCount = manifestPerms.length;

const manifestById = new Map();
for (const p of manifestPerms) manifestById.set(p.id, p);

// REST and MCP source entries
const manifestRestEntries = []; // { id, ref }
const manifestMcpEntries = []; // { id, ref }
for (const p of manifestPerms) {
  for (const s of p.sources || []) {
    if (s.source === "rest") manifestRestEntries.push({ id: p.id, ref: s.ref });
    else if (s.source === "mcp") manifestMcpEntries.push({ id: p.id, ref: s.ref });
  }
}

// ── 2. Parse generated TS ───────────────────────────────────────────
const genPath = path.join(REPO, "packages/permissions/src/generated/permissions.ts");
const genSrc = fs.readFileSync(genPath, "utf8");

// Parse PERMISSIONS entries. Each line:
// { id: "x", app: "y", resource: "...", verb: "...", is_destructive: false, requires_confirmation: false, is_read: true, requires_superuser: false },
const permLineRe =
  /\{\s*id:\s*"([^"]+)",\s*app:\s*"([^"]+)",\s*resource:\s*"([^"]+)",\s*verb:\s*"([^"]+)",\s*is_destructive:\s*(true|false),\s*requires_confirmation:\s*(true|false),\s*is_read:\s*(true|false),\s*requires_superuser:\s*(true|false)\s*\}/g;
const genPermsArr = [];
{
  // Restrict to between "const _PERMISSIONS_DATA" and the next "];"
  const start = genSrc.indexOf("const _PERMISSIONS_DATA");
  if (start === -1) throw new Error("Could not find _PERMISSIONS_DATA");
  const end = genSrc.indexOf("];", start);
  const body = genSrc.slice(start, end);
  let m;
  while ((m = permLineRe.exec(body)) !== null) {
    genPermsArr.push({
      id: m[1],
      app: m[2],
      resource: m[3],
      verb: m[4],
      is_destructive: m[5] === "true",
      requires_confirmation: m[6] === "true",
      is_read: m[7] === "true",
      requires_superuser: m[8] === "true",
    });
  }
}
const genById = new Map();
for (const p of genPermsArr) genById.set(p.id, p);

// Parse ROUTE_TO_PERMISSION and TOOL_TO_PERMISSION
function parseMap(name) {
  const re = new RegExp(
    `export const ${name}: ReadonlyMap<string, string> = new Map\\(\\[([\\s\\S]*?)\\]\\);`,
    "m",
  );
  const m = genSrc.match(re);
  if (!m) throw new Error(`Could not find map ${name}`);
  const body = m[1];
  const entries = [];
  const entryRe = /\["([^"]+)",\s*"([^"]+)"\]/g;
  let e;
  while ((e = entryRe.exec(body)) !== null) {
    entries.push([e[1], e[2]]);
  }
  return entries;
}
const genRouteEntries = parseMap("ROUTE_TO_PERMISSION");
const genToolEntries = parseMap("TOOL_TO_PERMISSION");

const genRouteMap = new Map(genRouteEntries);
const genToolMap = new Map(genToolEntries);

// ── 3. Query DB ─────────────────────────────────────────────────────
const dbCountStr = psql("SELECT COUNT(*) FROM permissions;").trim();
const dbCount = Number(dbCountStr);

const dbAllRaw = psql(
  "SELECT id, app, resource, verb, is_destructive, requires_confirmation, is_read, requires_superuser FROM permissions ORDER BY id;",
);
const dbPermsArr = [];
for (const line of dbAllRaw.split("\n")) {
  if (!line.trim()) continue;
  const parts = line.split("\t");
  if (parts.length < 8) continue;
  dbPermsArr.push({
    id: parts[0],
    app: parts[1],
    resource: parts[2],
    verb: parts[3],
    is_destructive: parts[4] === "t",
    requires_confirmation: parts[5] === "t",
    is_read: parts[6] === "t",
    requires_superuser: parts[7] === "t",
  });
}
const dbById = new Map();
for (const p of dbPermsArr) dbById.set(p.id, p);

// ── 4. Counts ───────────────────────────────────────────────────────
const counts = {
  manifest: manifestCount,
  manifestCountsTotal: manifest.counts.total,
  generatedTs: genPermsArr.length,
  database: dbCount,
  dbArrayLen: dbPermsArr.length,
};

// ── 5. ID set diff ──────────────────────────────────────────────────
const manifestIds = new Set(manifestPerms.map((p) => p.id));
const genIds = new Set(genPermsArr.map((p) => p.id));
const dbIds = new Set(dbPermsArr.map((p) => p.id));

function diff(a, b) {
  return [...a].filter((x) => !b.has(x));
}
const idDiff = {
  manifest_minus_gen: diff(manifestIds, genIds),
  gen_minus_manifest: diff(genIds, manifestIds),
  manifest_minus_db: diff(manifestIds, dbIds),
  db_minus_manifest: diff(dbIds, manifestIds),
  gen_minus_db: diff(genIds, dbIds),
  db_minus_gen: diff(dbIds, genIds),
};

// ── 6. Flag agreement (all entries, not just sample) ────────────────
const flagFields = [
  "is_read",
  "is_destructive",
  "requires_confirmation",
  "requires_superuser",
];
const flagMismatches = {
  manifest_vs_gen: [],
  manifest_vs_db: [],
  gen_vs_db: [],
};
for (const id of manifestIds) {
  const m = manifestById.get(id);
  const g = genById.get(id);
  const d = dbById.get(id);
  if (g) {
    for (const f of flagFields) {
      if (m[f] !== g[f]) {
        flagMismatches.manifest_vs_gen.push({ id, field: f, manifest: m[f], generated: g[f] });
      }
    }
  }
  if (d) {
    for (const f of flagFields) {
      if (m[f] !== d[f]) {
        flagMismatches.manifest_vs_db.push({ id, field: f, manifest: m[f], db: d[f] });
      }
    }
  }
  if (g && d) {
    for (const f of flagFields) {
      if (g[f] !== d[f]) {
        flagMismatches.gen_vs_db.push({ id, field: f, generated: g[f], db: d[f] });
      }
    }
  }
}

// Build a "sample of ~30" spanning apps for the report
const sampleApps = new Map();
for (const p of manifestPerms) {
  if (!sampleApps.has(p.app)) sampleApps.set(p.app, []);
  sampleApps.get(p.app).push(p.id);
}
const sampleIds = [];
for (const [app, ids] of sampleApps) {
  // pick first, middle, last per app
  sampleIds.push(ids[0]);
  if (ids.length > 2) sampleIds.push(ids[Math.floor(ids.length / 2)]);
  if (ids.length > 1) sampleIds.push(ids[ids.length - 1]);
}
const sampleRows = [];
for (const id of sampleIds) {
  const m = manifestById.get(id) || {};
  const g = genById.get(id) || {};
  const d = dbById.get(id) || {};
  sampleRows.push({
    id,
    app: m.app,
    is_read: { m: m.is_read, g: g.is_read, d: d.is_read, ok: m.is_read === g.is_read && g.is_read === d.is_read },
    is_destructive: {
      m: m.is_destructive,
      g: g.is_destructive,
      d: d.is_destructive,
      ok: m.is_destructive === g.is_destructive && g.is_destructive === d.is_destructive,
    },
    requires_confirmation: {
      m: m.requires_confirmation,
      g: g.requires_confirmation,
      d: d.requires_confirmation,
      ok: m.requires_confirmation === g.requires_confirmation && g.requires_confirmation === d.requires_confirmation,
    },
    requires_superuser: {
      m: m.requires_superuser,
      g: g.requires_superuser,
      d: d.requires_superuser,
      ok: m.requires_superuser === g.requires_superuser && g.requires_superuser === d.requires_superuser,
    },
  });
}

// ── 7. Map completeness ─────────────────────────────────────────────
// Build a manifest map ref → id  (per source kind)
const manifestRouteRefToIds = new Map(); // ref -> Set(ids)
for (const e of manifestRestEntries) {
  if (!manifestRouteRefToIds.has(e.ref)) manifestRouteRefToIds.set(e.ref, new Set());
  manifestRouteRefToIds.get(e.ref).add(e.id);
}
const manifestToolRefToIds = new Map();
for (const e of manifestMcpEntries) {
  if (!manifestToolRefToIds.has(e.ref)) manifestToolRefToIds.set(e.ref, new Set());
  manifestToolRefToIds.get(e.ref).add(e.id);
}

// REST entries in manifest absent from ROUTE_TO_PERMISSION
const missingRouteInGen = [];
for (const [ref, ids] of manifestRouteRefToIds) {
  if (!genRouteMap.has(ref)) {
    missingRouteInGen.push({ ref, ids: [...ids] });
  } else {
    const id = genRouteMap.get(ref);
    if (!ids.has(id)) {
      missingRouteInGen.push({ ref, ids: [...ids], gen_id: id, mismatch: true });
    }
  }
}

// Routes in generated map that don't appear in manifest
const orphanRoutesInGen = [];
for (const [ref, id] of genRouteMap) {
  if (!manifestRouteRefToIds.has(ref)) {
    orphanRoutesInGen.push({ ref, id, in_catalog: manifestIds.has(id) });
  }
}

// MCP tools
const missingToolInGen = [];
for (const [ref, ids] of manifestToolRefToIds) {
  if (!genToolMap.has(ref)) {
    missingToolInGen.push({ ref, ids: [...ids] });
  } else {
    const id = genToolMap.get(ref);
    if (!ids.has(id)) {
      missingToolInGen.push({ ref, ids: [...ids], gen_id: id, mismatch: true });
    }
  }
}
const orphanToolsInGen = [];
for (const [ref, id] of genToolMap) {
  if (!manifestToolRefToIds.has(ref)) {
    orphanToolsInGen.push({ ref, id, in_catalog: manifestIds.has(id) });
  }
}

// Map values pointing to IDs not in catalog
const routeMapBadIds = [];
for (const [ref, id] of genRouteMap) {
  if (!manifestIds.has(id)) routeMapBadIds.push({ ref, id });
}
const toolMapBadIds = [];
for (const [ref, id] of genToolMap) {
  if (!manifestIds.has(id)) toolMapBadIds.push({ ref, id });
}

// ── 8. requires_superuser ───────────────────────────────────────────
const suMfst = manifestPerms.filter((p) => p.requires_superuser).map((p) => p.id).sort();
const suGen = genPermsArr.filter((p) => p.requires_superuser).map((p) => p.id).sort();
const suDb = dbPermsArr.filter((p) => p.requires_superuser).map((p) => p.id).sort();
const requiresSuperuser = {
  manifest_count: suMfst.length,
  generated_count: suGen.length,
  db_count: suDb.length,
  manifest_minus_db: diff(new Set(suMfst), new Set(suDb)),
  db_minus_manifest: diff(new Set(suDb), new Set(suMfst)),
  manifest_minus_gen: diff(new Set(suMfst), new Set(suGen)),
  gen_minus_manifest: diff(new Set(suGen), new Set(suMfst)),
  ids_manifest_sample: suMfst.slice(0, 10),
};

// ── output ─────────────────────────────────────────────────────────
const report = {
  counts,
  idDiff: Object.fromEntries(
    Object.entries(idDiff).map(([k, v]) => [k, { count: v.length, sample: v.slice(0, 10) }]),
  ),
  flagMismatchesSummary: {
    manifest_vs_gen: flagMismatches.manifest_vs_gen.length,
    manifest_vs_db: flagMismatches.manifest_vs_db.length,
    gen_vs_db: flagMismatches.gen_vs_db.length,
    sample_manifest_vs_gen: flagMismatches.manifest_vs_gen.slice(0, 10),
    sample_manifest_vs_db: flagMismatches.manifest_vs_db.slice(0, 10),
    sample_gen_vs_db: flagMismatches.gen_vs_db.slice(0, 10),
  },
  sampleRowsCount: sampleRows.length,
  sampleAllOk: sampleRows.every(
    (r) =>
      r.is_read.ok && r.is_destructive.ok && r.requires_confirmation.ok && r.requires_superuser.ok,
  ),
  sampleRows,
  mapCompleteness: {
    manifest_rest_unique_refs: manifestRouteRefToIds.size,
    gen_route_entries: genRouteMap.size,
    manifest_mcp_unique_refs: manifestToolRefToIds.size,
    gen_tool_entries: genToolMap.size,
    missing_route_in_gen: { count: missingRouteInGen.length, sample: missingRouteInGen.slice(0, 10) },
    orphan_routes_in_gen: { count: orphanRoutesInGen.length, sample: orphanRoutesInGen.slice(0, 10) },
    missing_tool_in_gen: { count: missingToolInGen.length, sample: missingToolInGen.slice(0, 10) },
    orphan_tools_in_gen: { count: orphanToolsInGen.length, sample: orphanToolsInGen.slice(0, 10) },
    route_map_bad_ids: { count: routeMapBadIds.length, sample: routeMapBadIds.slice(0, 10) },
    tool_map_bad_ids: { count: toolMapBadIds.length, sample: toolMapBadIds.slice(0, 10) },
  },
  requiresSuperuser,
};

console.log(JSON.stringify(report, null, 2));
