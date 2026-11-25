CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  approval_id UUID REFERENCES approval_requests(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  input JSONB NOT NULL,
  result JSONB,
  progress JSONB NOT NULL DEFAULT '{"stage":"queued","message":"Waiting for a worker."}'::jsonb,
  error JSONB,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  cancel_requested_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_user_created_idx ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (status, lease_expires_at, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS jobs_agent_run_idx ON jobs (agent_run_id)
  WHERE agent_run_id IS NOT NULL;
