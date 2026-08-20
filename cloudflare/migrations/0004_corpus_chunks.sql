-- Semantic retrieval over the corpus.
--
-- Keyword search cannot bridge vocabulary. "The sill end is rotten over 400mm"
-- shares no word with "stop-splayed scarf joint", and no amount of term
-- matching closes that gap — which matters because the practitioner who most
-- needs the joinery manual is exactly the one who does not yet know to ask for
-- it by name. Extracted `indications` help, but only for gaps the ingesting
-- model happened to anticipate, and not at all across languages: someone typing
-- "fauler Balkenkopf" matches nothing in an English corpus.
--
-- Embeddings solve it properly. Each chunk carries a vector; a query is
-- embedded the same way; cosine similarity ranks by meaning rather than by
-- shared characters, across paraphrase and across languages.
--
-- Storage: vectors are int8-quantised and base64'd. A 768-dimension float32
-- vector is 3 KB, which at a few hundred chunks is megabytes to drag out of D1
-- per query. Quantised it is 768 bytes — about 1 KB base64 — and the precision
-- lost is far below what retrieval ranking can notice.
--
-- No ANN index, deliberately. Scope already narrows the candidate set hard: a
-- strategy sees project documents plus its own, which at workshop scale is tens
-- of documents and a few hundred chunks. Brute-force cosine over that is
-- sub-millisecond in the Worker and needs no extra infrastructure. If a corpus
-- ever reaches tens of thousands of chunks, this is the seam where Cloudflare
-- Vectorize slots in behind the same search route.

CREATE TABLE IF NOT EXISTS rw_corpus_chunks (
  project_id  TEXT NOT NULL,
  doc_id      TEXT NOT NULL,
  chunk_ix    INTEGER NOT NULL,

  -- Denormalised from rw_corpus_docs so a search can filter by scope without
  -- joining. The read path runs on every retrieval; the write path runs once
  -- per document.
  scope       TEXT NOT NULL DEFAULT 'project',
  author_key  TEXT,
  plan_id     TEXT,

  -- 'summary' | 'text' | 'figure' | 'indication'. Kept so a figure chunk can be
  -- weighted differently from body prose, and so a hit can tell the model
  -- whether to go and LOOK at the page.
  kind        TEXT NOT NULL DEFAULT 'text',
  label       TEXT,
  content     TEXT NOT NULL,

  vector      TEXT NOT NULL,          -- base64 of an Int8Array
  dims        INTEGER NOT NULL,
  created_at  TEXT NOT NULL,

  PRIMARY KEY (project_id, doc_id, chunk_ix),
  FOREIGN KEY (project_id) REFERENCES rw_projects(id) ON DELETE CASCADE
);

-- The retrieval filter, in the order the query applies it.
CREATE INDEX IF NOT EXISTS idx_rw_chunks_scope
  ON rw_corpus_chunks (project_id, scope);

CREATE INDEX IF NOT EXISTS idx_rw_chunks_plan
  ON rw_corpus_chunks (project_id, author_key, plan_id);

CREATE INDEX IF NOT EXISTS idx_rw_chunks_doc
  ON rw_corpus_chunks (project_id, doc_id);
