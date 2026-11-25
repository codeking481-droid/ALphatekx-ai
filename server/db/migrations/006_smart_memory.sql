ALTER TABLE memory_records
  DROP CONSTRAINT IF EXISTS memory_records_kind_check;

ALTER TABLE memory_records
  ADD CONSTRAINT memory_records_kind_check
  CHECK (kind IN (
    'fact',
    'preference',
    'project',
    'lesson-learned',
    'conversation_context',
    'project_context',
    'task_history',
    'agent_history'
  ));
