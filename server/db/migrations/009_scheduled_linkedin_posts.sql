CREATE TABLE IF NOT EXISTS scheduled_linkedin_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  source_execution_id UUID REFERENCES tool_executions(id) ON DELETE SET NULL,
  batch_id UUID NOT NULL,
  post_text TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'cancelled')),
  post_id TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_linkedin_posts_due_idx
  ON scheduled_linkedin_posts (scheduled_for, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS scheduled_linkedin_posts_user_idx
  ON scheduled_linkedin_posts (user_id, created_at DESC);
