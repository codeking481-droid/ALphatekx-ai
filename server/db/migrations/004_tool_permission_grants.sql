CREATE TABLE IF NOT EXISTS tool_permission_grants (
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  tool_id TEXT NOT NULL REFERENCES tool_definitions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tool_id, scope)
);

CREATE INDEX IF NOT EXISTS tool_permission_grants_user_idx
  ON tool_permission_grants (user_id, granted_at DESC);
