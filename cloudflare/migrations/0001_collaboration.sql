PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rw_projects (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  base_workspace  TEXT NOT NULL,
  model_key       TEXT,
  model_version   TEXT NOT NULL DEFAULT '1',
  source_type     TEXT NOT NULL DEFAULT 'custom',
  source_ref      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS rw_conditions (
  project_id      TEXT NOT NULL,
  id              TEXT NOT NULL,
  author_key      TEXT NOT NULL,
  author_name     TEXT NOT NULL,
  condition_data  TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at      TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id) REFERENCES rw_projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rw_conditions_project_author
  ON rw_conditions(project_id, author_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_rw_conditions_project
  ON rw_conditions(project_id)
  WHERE deleted_at IS NULL;
