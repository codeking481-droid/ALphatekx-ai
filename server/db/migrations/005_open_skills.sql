CREATE TABLE IF NOT EXISTS user_skills (
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);

CREATE INDEX IF NOT EXISTS user_skills_user_enabled_idx
  ON user_skills (user_id, enabled, name);

CREATE TABLE IF NOT EXISTS skill_install_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('install', 'enable')),
  markdown TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (markdown IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS skill_install_requests_user_status_idx
  ON skill_install_requests (user_id, status, created_at DESC);
