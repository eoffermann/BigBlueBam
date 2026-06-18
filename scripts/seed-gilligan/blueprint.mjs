/**
 * Gilligan's Island themed Blueprint (structured-diagram) seed.
 *
 * The Professor keeps the island's schematics in Blueprint: the coconut radio,
 * the (latest) raft, the rescue signal flow, and a working map of the place.
 * Idempotent by diagram name: a diagram is skipped entirely if one with the
 * same name already has nodes (so re-running won't double up the graph).
 *
 * Run from the repo host (cast API keys authenticate via Bearer, which bypasses
 * CSRF and scopes to the Gilligan org; the api container can reach the internal
 * blueprint-api host):
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/blueprint.mjs
 */

// Blueprint API internal host. Routes live under /v1 (see
// apps/blueprint-api/src/server.ts: register(..., { prefix: '/v1' })).
// Note: bureau-api also binds container-internal port 4015, but each service
// is its own container network namespace, so the `blueprint-api` hostname
// resolves to the right upstream.
const API = 'http://blueprint-api:4015/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Cast user ids (mirror of scripts/seed-gilligan/bam.mjs CAST map).
const CAST = {
  skipper: '415a22d7-7ffa-4ffc-a07f-128a25989ece',
  professor: '685d424e-ceb1-453a-b605-c66aa1c6d8cf',
  gilligan: '0f47c55f-4c7d-4100-a00b-ca131a1e864d',
  maryann: 'd2835cc4-8ee9-4a27-b43e-84ab19a21450',
  ginger: 'c8926754-2a93-4bd6-bf20-5b1f87e27385',
  howell: '414d283d-f13b-4608-91db-dfd024db4064',
  lovey: '0ddd0b3e-4de3-4077-a905-07878dc43960',
};

function H(who) {
  return { Authorization: `Bearer ${KEYS[who]}`, 'Content-Type': 'application/json' };
}
async function api(who, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: H(who),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 240)}`);
  return data.data ?? data;
}

const asArr = (v) => (Array.isArray(v) ? v : (v?.data ?? []));

/**
 * Each diagram: name/description/type/author + node list + edge list.
 * Nodes are keyed by a local `ref` used to wire edges (not persisted server-side).
 * Positions are authored by hand so the canvas reads left-to-right / top-to-bottom
 * without needing an ELK layout pass.
 */
const DIAGRAMS = [
  {
    name: 'Coconut Radio — Wiring Diagram',
    type: 'schematic',
    author: 'professor',
    description:
      "Professor's coconut-powered receiver. Theory is sound; reception depends entirely on the weather, the tide, and whether Gilligan is leaning on the antenna.",
    nodes: [
      { ref: 'antenna', label: 'Longwire Antenna\n(between the two tallest palms)', shape: 'rounded', x: 40, y: 40 },
      { ref: 'coil', label: 'Tuning Coil\n(wound on a bamboo dowel)', shape: 'rectangle', x: 320, y: 40 },
      { ref: 'crystal', label: 'Galena Crystal\n+ cat-whisker detector', shape: 'diamond', x: 600, y: 40 },
      { ref: 'battery', label: 'Coconut Battery\n(copper penny + galvanized nail)', shape: 'cylinder', x: 320, y: 260 },
      { ref: 'earpiece', label: 'Earpiece\n(Skipper: NO eating)', shape: 'circle', x: 880, y: 150 },
      { ref: 'ground', label: 'Ground Stake\n(driven into the wet sand)', shape: 'rectangle', x: 600, y: 280 },
    ],
    edges: [
      { from: 'antenna', to: 'coil', label: 'RF in', kind: 'data_flow' },
      { from: 'coil', to: 'crystal', label: 'tuned signal', kind: 'data_flow' },
      { from: 'crystal', to: 'earpiece', label: 'detected audio', kind: 'data_flow' },
      { from: 'battery', to: 'coil', label: 'bias (+3V-ish)', kind: 'power' },
      { from: 'crystal', to: 'ground', label: 'return path', kind: 'power' },
      { from: 'ground', to: 'antenna', label: 'earth reference', kind: 'reference' },
    ],
  },
  {
    name: 'Raft v3 — Assembly',
    type: 'flowchart',
    author: 'skipper',
    description:
      "Third time's the charm. Build steps for the escape raft, in order. Sea trial in the lagoon ONLY — and the Skipper steers, not the first mate.",
    nodes: [
      { ref: 'hull', label: 'Lash the Bamboo Hull\n(40 cured lengths)', shape: 'rounded', x: 40, y: 60 },
      { ref: 'lashings', label: 'Double the Vine Lashings\n(Professor tensile-tested)', shape: 'rounded', x: 320, y: 60 },
      { ref: 'mast', label: 'Step the Mast', shape: 'rounded', x: 600, y: 60 },
      { ref: 'sail', label: "Rig the Sail\n(Howells' spare linen)", shape: 'rounded', x: 600, y: 240 },
      { ref: 'rudder', label: 'Mount the Rudder', shape: 'rounded', x: 320, y: 240 },
      { ref: 'trial', label: 'Lagoon Sea-Trial\n(high tide)', shape: 'diamond', x: 40, y: 240 },
      { ref: 'launch', label: 'Stock & Launch', shape: 'circle', x: 40, y: 420 },
    ],
    edges: [
      { from: 'hull', to: 'lashings', label: 'step 1 → 2', kind: 'sequence' },
      { from: 'lashings', to: 'mast', label: 'step 2 → 3', kind: 'sequence' },
      { from: 'mast', to: 'sail', label: 'step 3 → 4', kind: 'sequence' },
      { from: 'sail', to: 'rudder', label: 'step 4 → 5', kind: 'sequence' },
      { from: 'rudder', to: 'trial', label: 'step 5 → 6', kind: 'sequence' },
      { from: 'trial', to: 'launch', label: 'passed!', kind: 'sequence' },
      { from: 'trial', to: 'hull', label: 'leaks — re-lash', kind: 'rework' },
    ],
  },
  {
    name: 'Rescue Signal Flow',
    type: 'flowchart',
    author: 'skipper',
    description:
      'Decision flow for the moment a ship (or plane) is spotted. Run it top to bottom; everyone has a station. Do NOT skip the flag — they never see the fire in daylight.',
    nodes: [
      { ref: 'spot', label: 'Spot a Ship / Plane', shape: 'circle', x: 360, y: 40 },
      { ref: 'fire', label: 'Light the Signal Fire\n(Lookout Point)', shape: 'rounded', x: 360, y: 200 },
      { ref: 'mirror', label: 'Flash the Coconut-Shell Mirror', shape: 'rounded', x: 360, y: 360 },
      { ref: 'flag', label: 'Wave the Big HELP Flag', shape: 'rounded', x: 360, y: 520 },
      { ref: 'decide', label: 'Did they see us?', shape: 'diamond', x: 360, y: 680 },
      { ref: 'rescued', label: 'RESCUED!\n(finally)', shape: 'circle', x: 100, y: 860 },
      { ref: 'retry', label: 'Regroup & Try Again Tomorrow', shape: 'rounded', x: 640, y: 860 },
    ],
    edges: [
      { from: 'spot', to: 'fire', label: 'sound the conch', kind: 'sequence' },
      { from: 'fire', to: 'mirror', label: 'then', kind: 'sequence' },
      { from: 'mirror', to: 'flag', label: 'then', kind: 'sequence' },
      { from: 'flag', to: 'decide', label: 'watch the horizon', kind: 'sequence' },
      { from: 'decide', to: 'rescued', label: 'YES', kind: 'decision' },
      { from: 'decide', to: 'retry', label: 'NO (again?!)', kind: 'decision' },
      { from: 'retry', to: 'spot', label: 'reset stations', kind: 'loop' },
    ],
  },
  {
    name: 'Island Map',
    type: 'map',
    author: 'professor',
    description:
      "Survey of the island as best the Professor can pace it off. Distances approximate; the lagoon is the only safe launch point and the Howell estate is, predictably, the largest hut.",
    nodes: [
      { ref: 'lagoon', label: 'The Lagoon\n(safe harbor / sea trials)', shape: 'rounded', x: 80, y: 380 },
      { ref: 'huts', label: 'Castaway Huts\n(the commons)', shape: 'rectangle', x: 400, y: 320 },
      { ref: 'radiohut', label: 'Radio Hut\n(Professor’s lab)', shape: 'rectangle', x: 400, y: 120 },
      { ref: 'lookout', label: 'Lookout Point\n(signal fire)', shape: 'diamond', x: 720, y: 80 },
      { ref: 'estate', label: 'Howell Estate\n("the West Wing")', shape: 'rectangle', x: 720, y: 360 },
    ],
    edges: [
      { from: 'lagoon', to: 'huts', label: 'beach path', kind: 'path' },
      { from: 'huts', to: 'radiohut', label: 'short trail', kind: 'path' },
      { from: 'huts', to: 'estate', label: 'gravel walk', kind: 'path' },
      { from: 'radiohut', to: 'lookout', label: 'ridge climb', kind: 'path' },
      { from: 'estate', to: 'lookout', label: 'scenic route', kind: 'path' },
    ],
  },
];

(async () => {
  let diagramsCreated = 0;
  let diagramsSkipped = 0;
  let totalNodes = 0;
  let totalEdges = 0;
  const failures = [];

  for (const spec of DIAGRAMS) {
    const who = spec.author;
    let diagram;
    try {
      // Find-or-create by name (author's visible diagram list).
      const existing = asArr(await api(who, 'GET', '/diagrams'));
      diagram = existing.find((d) => d.name === spec.name && !d.is_archived);
      if (diagram) {
        // Idempotency: if it already has nodes, leave it untouched.
        const nodes = asArr(await api(who, 'GET', `/diagrams/${diagram.id}/nodes`));
        if (nodes.length > 0) {
          console.log(`diagram exists, populated — skip: ${spec.name} (${diagram.id}, ${nodes.length} nodes)`);
          diagramsSkipped++;
          continue;
        }
        console.log(`diagram exists, empty — populating: ${spec.name} (${diagram.id})`);
      } else {
        diagram = await api(who, 'POST', '/diagrams', {
          name: spec.name,
          description: spec.description,
          diagram_type: spec.type,
          visibility: 'organization',
        });
        diagramsCreated++;
        console.log(`diagram: ${spec.name} (${diagram.id})`);
      }
    } catch (e) {
      console.log(`  diagram failed: ${spec.name} — ${e.message}`);
      failures.push(`${spec.name} [create]: ${e.message}`);
      continue;
    }

    // Add nodes; remember server uuid per local ref to wire edges.
    const idByRef = {};
    for (const n of spec.nodes) {
      try {
        const row = await api(who, 'POST', `/diagrams/${diagram.id}/nodes`, {
          shape: n.shape,
          label: n.label,
          position_x: n.x,
          position_y: n.y,
          width: 200,
          height: 90,
        });
        idByRef[n.ref] = row.id;
        totalNodes++;
      } catch (e) {
        console.log(`  node failed: ${spec.name}/${n.ref} — ${e.message}`);
        failures.push(`${spec.name}/${n.ref} [node]: ${e.message}`);
      }
    }

    // Add edges by resolved uuids.
    for (const e of spec.edges) {
      const src = idByRef[e.from];
      const tgt = idByRef[e.to];
      if (!src || !tgt) {
        console.log(`  edge skipped (missing endpoint): ${spec.name} ${e.from}->${e.to}`);
        failures.push(`${spec.name} ${e.from}->${e.to} [edge]: missing endpoint`);
        continue;
      }
      try {
        await api(who, 'POST', `/diagrams/${diagram.id}/edges`, {
          source_node_id: src,
          target_node_id: tgt,
          label: e.label,
          kind: e.kind,
          marker_end: 'arrow',
        });
        totalEdges++;
      } catch (err) {
        console.log(`  edge failed: ${spec.name} ${e.from}->${e.to} — ${err.message}`);
        failures.push(`${spec.name} ${e.from}->${e.to} [edge]: ${err.message}`);
      }
    }

    console.log(`  + ${spec.nodes.length} nodes, ${spec.edges.length} edges`);
  }

  console.log(
    `\nBlueprint seed done: ${diagramsCreated} created, ${diagramsSkipped} skipped (already populated), ` +
      `${totalNodes} nodes, ${totalEdges} edges.`,
  );
  if (failures.length) {
    console.log(`\nFAILURES (${failures.length}):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('blueprint seed failed:', e.message);
  process.exit(1);
});
