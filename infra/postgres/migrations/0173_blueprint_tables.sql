-- 0173_blueprint_tables.sql
-- Why: Introduces the Blueprint structured-diagram product. Blueprint is to
--       diagrams what Bam is to tasks — a typed, queryable, MCP-addressable
--       data model rather than an opaque collaboration blob. The graph
--       lives in blueprint_nodes + blueprint_edges and IS the source of
--       truth; a Yjs layer (added in a follow-up commit) carries only
--       live multiplayer state. This migration creates the seven tables
--       that back the entire MVP: diagrams, nodes, edges, version
--       snapshots, per-diagram collaborators, templates, anchored
--       comments, and stars.
-- Client impact: additive only — no existing column or table is touched.

-- ─── blueprint_diagrams ─────────────────────────────────────────────────
-- The diagram entity itself. yjs_state is reserved for the future Yjs
-- layer; until that ships, mutations all go through the REST routes and
-- broadcast via Redis PubSub, identical to Bam/Bond/Banter.
CREATE TABLE IF NOT EXISTS blueprint_diagrams (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id        uuid REFERENCES projects(id) ON DELETE SET NULL,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  name              varchar(200) NOT NULL,
  slug              varchar(200),
  description       text,
  diagram_type      varchar(32) NOT NULL DEFAULT 'flowchart',
  layout_algorithm  varchar(32) NOT NULL DEFAULT 'layered',
  layout_options    jsonb NOT NULL DEFAULT '{}'::jsonb,
  canvas_settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  visibility        varchar(16) NOT NULL DEFAULT 'project',
  yjs_state         bytea,
  thumbnail_key     text,
  is_archived       boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blueprint_diagrams_org_idx
  ON blueprint_diagrams(org_id);
CREATE INDEX IF NOT EXISTS blueprint_diagrams_project_idx
  ON blueprint_diagrams(project_id);
CREATE INDEX IF NOT EXISTS blueprint_diagrams_active_idx
  ON blueprint_diagrams(org_id) WHERE is_archived = false;
CREATE INDEX IF NOT EXISTS blueprint_diagrams_slug_idx
  ON blueprint_diagrams(org_id, slug) WHERE slug IS NOT NULL;

-- ─── blueprint_nodes ────────────────────────────────────────────────────
-- parent_node_id is the universal container/lane/subgraph pointer.
-- Swimlanes are just container nodes whose children layout into the lane.
-- ref_entity_type/ref_entity_id let a node represent a cross-product
-- entity (a Bam task, a Beacon entry, a Bond deal) — the actual entity is
-- the source of truth, this is a typed reference.
CREATE TABLE IF NOT EXISTS blueprint_nodes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  parent_node_id    uuid REFERENCES blueprint_nodes(id) ON DELETE CASCADE,
  shape             varchar(32) NOT NULL DEFAULT 'rounded',
  label             text NOT NULL DEFAULT '',
  description       text,
  position_x        double precision NOT NULL DEFAULT 0,
  position_y        double precision NOT NULL DEFAULT 0,
  width             double precision NOT NULL DEFAULT 160,
  height            double precision NOT NULL DEFAULT 56,
  z_index           integer NOT NULL DEFAULT 0,
  pinned            boolean NOT NULL DEFAULT false,
  style             jsonb NOT NULL DEFAULT '{}'::jsonb,
  data              jsonb NOT NULL DEFAULT '{}'::jsonb,
  ref_entity_type   varchar(32),
  ref_entity_id     uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blueprint_nodes_diagram_idx
  ON blueprint_nodes(diagram_id);
CREATE INDEX IF NOT EXISTS blueprint_nodes_parent_idx
  ON blueprint_nodes(parent_node_id);
CREATE INDEX IF NOT EXISTS blueprint_nodes_ref_idx
  ON blueprint_nodes(ref_entity_type, ref_entity_id)
  WHERE ref_entity_type IS NOT NULL;

-- ─── blueprint_edges ────────────────────────────────────────────────────
-- waypoints is an array of {x,y} pairs for manual routing; NULL = auto.
-- source_handle/target_handle bind connections to specific ports on a
-- node when the shape has multiple anchors.
CREATE TABLE IF NOT EXISTS blueprint_edges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  source_node_id    uuid NOT NULL REFERENCES blueprint_nodes(id) ON DELETE CASCADE,
  target_node_id    uuid NOT NULL REFERENCES blueprint_nodes(id) ON DELETE CASCADE,
  source_handle     varchar(64),
  target_handle     varchar(64),
  kind              varchar(32) NOT NULL DEFAULT 'default',
  label             text,
  marker_start      varchar(16) NOT NULL DEFAULT 'none',
  marker_end        varchar(16) NOT NULL DEFAULT 'arrowclosed',
  style             jsonb NOT NULL DEFAULT '{}'::jsonb,
  waypoints         jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blueprint_edges_diagram_idx
  ON blueprint_edges(diagram_id);
CREATE INDEX IF NOT EXISTS blueprint_edges_source_idx
  ON blueprint_edges(source_node_id);
CREATE INDEX IF NOT EXISTS blueprint_edges_target_idx
  ON blueprint_edges(target_node_id);

-- ─── blueprint_diagram_versions ─────────────────────────────────────────
-- Snapshots of the full graph at a labeled point in time. Restore writes
-- the snapshot back over the current nodes/edges in a transaction.
CREATE TABLE IF NOT EXISTS blueprint_diagram_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  version_number    integer NOT NULL,
  label             varchar(200),
  snapshot          jsonb NOT NULL,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (diagram_id, version_number)
);
CREATE INDEX IF NOT EXISTS blueprint_diagram_versions_diagram_idx
  ON blueprint_diagram_versions(diagram_id);

-- ─── blueprint_collaborators ────────────────────────────────────────────
-- Per-diagram role overlay. Layers on top of org/project visibility for
-- one-off shares (e.g. a private diagram explicitly shared with one
-- editor across project boundaries).
CREATE TABLE IF NOT EXISTS blueprint_collaborators (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role              varchar(16) NOT NULL DEFAULT 'editor',
  added_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (diagram_id, user_id)
);
CREATE INDEX IF NOT EXISTS blueprint_collaborators_user_idx
  ON blueprint_collaborators(user_id);

-- ─── blueprint_templates ────────────────────────────────────────────────
-- Reusable seed definitions. is_system = true rows are seeded by a
-- follow-up migration and visible to every org; org_id IS NOT NULL rows
-- are org-private.
CREATE TABLE IF NOT EXISTS blueprint_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name              varchar(200) NOT NULL,
  description       text,
  diagram_type      varchar(32) NOT NULL DEFAULT 'flowchart',
  definition        jsonb NOT NULL,
  is_system         boolean NOT NULL DEFAULT false,
  thumbnail_key     text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blueprint_templates_org_idx
  ON blueprint_templates(org_id);
CREATE INDEX IF NOT EXISTS blueprint_templates_system_idx
  ON blueprint_templates(is_system) WHERE is_system = true;

-- ─── blueprint_comments ─────────────────────────────────────────────────
-- node_id NULL = diagram-level comment. resolved is a simple bool;
-- threading is deferred until we see real usage patterns.
CREATE TABLE IF NOT EXISTS blueprint_comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  node_id           uuid REFERENCES blueprint_nodes(id) ON DELETE CASCADE,
  author_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  body              text NOT NULL,
  body_plain        text,
  resolved          boolean NOT NULL DEFAULT false,
  edited_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blueprint_comments_diagram_idx
  ON blueprint_comments(diagram_id);
CREATE INDEX IF NOT EXISTS blueprint_comments_node_idx
  ON blueprint_comments(node_id);

-- ─── blueprint_stars ────────────────────────────────────────────────────
-- User-favorites for surfacing in the list page.
CREATE TABLE IF NOT EXISTS blueprint_stars (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diagram_id        uuid NOT NULL REFERENCES blueprint_diagrams(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (diagram_id, user_id)
);
CREATE INDEX IF NOT EXISTS blueprint_stars_user_idx
  ON blueprint_stars(user_id);
