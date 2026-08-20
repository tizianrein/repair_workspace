-- The corpus: source material the AI reads to ground what it says.
--
-- Two tiers, and the distinction between them is the whole point:
--
--   scope = 'project'   Shared by everyone in the project. The structure's
--                       documentation, the survey report, the repair brief.
--                       User-independent on purpose: divergence between
--                       participants must come from what they DO with the
--                       material, not from having been given different
--                       material.
--
--   scope = 'strategy'  Attached to one plan, and visible ONLY to that plan.
--                       This is the mechanism that produces genuinely
--                       different repairs. If every strategy could read every
--                       document, they would converge on one evidence base and
--                       the divergence would be cosmetic. Isolation is a
--                       feature, not an oversight.
--
-- Blobs and extracted text live in R2; this table is the index. `summary` is
-- written at ingest and is what travels in the model's context by default —
-- roughly 40 tokens per document instead of the whole thing, so a 50-document
-- corpus costs ~2k tokens to be aware of rather than ~500k. Full text is
-- fetched only when the model asks for a specific document.

CREATE TABLE IF NOT EXISTS rw_corpus_docs (
  project_id   TEXT NOT NULL,
  id           TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'project',   -- 'project' | 'strategy'
  -- Set only for scope='strategy'. Plan ids live inside a participant's layer,
  -- so a strategy document is identified by the pair (author_key, plan_id):
  -- two participants can hold plans with different ids and never collide.
  author_key   TEXT,
  author_name  TEXT,
  plan_id      TEXT,

  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  byte_size    INTEGER NOT NULL DEFAULT 0,
  -- What role this document plays, chosen by the uploader. One dropdown that
  -- removes a lot of ambiguity later: "this describes the structure" and
  -- "this states the repair goal" are different instructions to the model.
  doc_kind     TEXT NOT NULL DEFAULT 'reference', -- structure|goal|technique|reference

  r2_key       TEXT NOT NULL,                     -- projects/<id>/corpus/<docId>
  text_key     TEXT,                              -- projects/<id>/corpus/<docId>.txt
  summary      TEXT,                              -- 2-4 sentences, written at ingest
  key_facts    TEXT,                              -- JSON array of extracted claims
  status       TEXT NOT NULL DEFAULT 'uploaded',  -- uploaded|ingesting|ready|failed
  error        TEXT,

  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,

  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES rw_projects(id) ON DELETE CASCADE
);

-- The read path is always "everything in scope for this strategy", which is
-- project-wide documents plus this one plan's. Both halves are indexed.
CREATE INDEX IF NOT EXISTS idx_rw_corpus_project_scope
  ON rw_corpus_docs (project_id, scope, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rw_corpus_plan
  ON rw_corpus_docs (project_id, author_key, plan_id);
