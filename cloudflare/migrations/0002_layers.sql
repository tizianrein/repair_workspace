-- Participant layers.
--
-- Until now the only per-participant state on the server was conditions
-- (rw_conditions). Everything else a participant produced — their strategies,
-- their intents and constraints, their conversations, their execution log, and
-- their copy of the parts model — lived in one browser's localStorage and was
-- lost the moment they switched device or cleared site data. For a workshop
-- whose entire output is divergent repair strategies, that is the wrong thing
-- to keep only on a laptop.
--
-- A layer is now the whole workspace for one participant within one project:
--   { instance (parts), conditions, plans, evidence, conversations, executionLog }
--
-- The parts model sits INSIDE the layer deliberately. Participants may adapt
-- the artefact to what they actually observe, and those edits stay in their own
-- copy rather than reaching under everyone else's conditions and step
-- references. The project keeps the seed artefact everyone starts from.
--
-- The body lives in R2, not here. D1 rows are capped around 1.8 MB and a layer
-- with a few chat threads passes that quickly; R2 has no such ceiling. What
-- stays in D1 is the metadata needed to list participants and detect conflicts
-- without fetching every layer.

CREATE TABLE IF NOT EXISTS rw_layers (
  project_id   TEXT NOT NULL,
  author_key   TEXT NOT NULL,
  author_name  TEXT NOT NULL,
  layer_key    TEXT NOT NULL,                 -- R2 key: projects/<id>/layers/<authorKey>.json
  rev          INTEGER NOT NULL DEFAULT 1,    -- bumped per accepted write; basis of conflict detection
  part_ct      INTEGER NOT NULL DEFAULT 0,
  condition_ct INTEGER NOT NULL DEFAULT 0,
  plan_ct      INTEGER NOT NULL DEFAULT 0,
  rendering_ct INTEGER NOT NULL DEFAULT 0,
  byte_size    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  -- Keyed by author within a project. Unlike rw_conditions, whose primary key
  -- omitted the author and so let one participant's row be taken over by
  -- another, ownership here is part of the identity of the row.
  PRIMARY KEY (project_id, author_key),
  FOREIGN KEY (project_id) REFERENCES rw_projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rw_layers_project
  ON rw_layers (project_id, updated_at DESC);

-- rw_conditions is deliberately NOT dropped. Projects already running against
-- the deployed worker have live data in it, and a layer body cannot be
-- constructed in SQL because it lives in R2. The worker instead falls back to
-- rw_conditions when a participant has no layer yet, and writes a real layer on
-- their first save — so existing work migrates itself on first use, with no
-- destructive step and no downtime.
