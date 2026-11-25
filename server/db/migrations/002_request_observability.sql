ALTER TABLE ai_usage_events ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE INDEX IF NOT EXISTS ai_usage_request_idx ON ai_usage_events (request_id) WHERE request_id IS NOT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS conversations_project_updated_idx ON conversations (project_id, updated_at DESC) WHERE project_id IS NOT NULL;
