CREATE TABLE IF NOT EXISTS linkedin_connections (
  user_id TEXT PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  linkedin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_encrypted BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS linkedin_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS linkedin_oauth_states_expires_idx ON linkedin_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS linkedin_action_approvals (
  approval_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('post', 'reply')),
  payload_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS linkedin_action_approvals_expires_idx ON linkedin_action_approvals (expires_at);
