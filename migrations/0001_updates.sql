CREATE TABLE IF NOT EXISTS updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'done', 'failed')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS updates_created_at ON updates(created_at);
