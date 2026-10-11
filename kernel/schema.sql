-- Relay kernel state: D1 for scheduling, Git notes for memory.
-- Kept in sync with migrate2.sql / migrate3.sql (fresh installs run only this file).
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,             -- tsk_xxxxxxxxxx
  spec TEXT NOT NULL,
  baseline_repo TEXT NOT NULL,
  workspace_repo TEXT,
  workspace_remote TEXT,
  fork_base_sha TEXT,
  forked_at TEXT,                  -- workspace birth; temporal overlap rule uses this
  status TEXT NOT NULL DEFAULT 'queued',
  -- queued -> assigned -> pushed -> (review) awaiting_merge -> merging -> merged
  --                \-> failed                \-> review_failed -> assigned...
  --                                            \-> re_forked -> assigned...
  assigned_agent TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  touch_set TEXT,                  -- JSON array of changed file paths
  head_sha TEXT,
  review TEXT,                     -- JSON: {verdict, reason, instructions, model}
  merged_sha TEXT,
  merged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provenance (
  repo TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  task_id TEXT,
  agent TEXT,
  model TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
