ALTER TABLE skill_install_requests
  ADD COLUMN IF NOT EXISTS supporting_files JSONB NOT NULL DEFAULT '[]'::jsonb;
