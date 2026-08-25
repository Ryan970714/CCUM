-- Claude Code usage dashboard — D1 schema
-- message_id is the true idempotency key: a single assistant API response is split
-- across multiple JSONL lines (thinking/text/tool_use), each carrying an identical
-- copy of usage but a different line uuid. Using message_id as PRIMARY KEY means
-- every ingest is a safe INSERT OR IGNORE, even if the same message is sent twice.

CREATE TABLE IF NOT EXISTS usage_events (
  message_id                     TEXT PRIMARY KEY,
  line_uuid                      TEXT,
  session_id                     TEXT NOT NULL,
  project_cwd                    TEXT NOT NULL,
  project_name                   TEXT NOT NULL,
  is_subagent                    INTEGER NOT NULL DEFAULT 0,
  agent_type                     TEXT,
  model                          TEXT NOT NULL,
  git_branch                     TEXT,
  timestamp                      TEXT NOT NULL,
  event_date                     TEXT NOT NULL,
  input_tokens                   INTEGER NOT NULL DEFAULT 0,
  output_tokens                  INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_creation_5m_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_creation_1h_tokens       INTEGER NOT NULL DEFAULT 0,
  thinking_tokens                INTEGER NOT NULL DEFAULT 0,
  service_tier                   TEXT,
  device_hostname                TEXT,
  ingested_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_events_date    ON usage_events(event_date);
CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events(project_name);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_model   ON usage_events(model);
CREATE INDEX IF NOT EXISTS idx_usage_events_device  ON usage_events(device_hostname);

-- Periodic snapshots of Anthropic's account-level 5h/7d rate-limit utilization, polled by
-- the watcher from the undocumented https://api.anthropic.com/api/oauth/usage endpoint
-- using the OAuth token Claude Code already stores locally. Append-only log (not just a
-- single latest row) so the dashboard could later chart utilization over time if wanted.
CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at                     TEXT NOT NULL,
  device_hostname                 TEXT,
  five_hour_utilization           REAL,
  five_hour_resets_at             TEXT,
  seven_day_utilization           REAL,
  seven_day_resets_at             TEXT,
  seven_day_sonnet_utilization    REAL,
  seven_day_sonnet_resets_at      TEXT,
  seven_day_opus_utilization      REAL,
  seven_day_opus_resets_at        TEXT,
  raw_json                        TEXT
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_captured ON rate_limit_snapshots(captured_at);
