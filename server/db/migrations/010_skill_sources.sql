ALTER TABLE user_skills
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'upload'
  CHECK (source IN ('upload', 'biz'));

ALTER TABLE skill_install_requests
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'upload'
  CHECK (source IN ('upload', 'biz'));

UPDATE skill_install_requests request
SET source = 'biz'
WHERE EXISTS (
  SELECT 1
  FROM audit_logs event
  WHERE event.user_id = request.user_id
    AND event.event = 'skill.approval.requested'
    AND event.resource_id = request.id::text
    AND event.details->>'source' IN ('create-skill', 'biz')
);

UPDATE user_skills installed
SET source = 'biz'
WHERE EXISTS (
  SELECT 1
  FROM audit_logs event
  WHERE event.user_id = installed.user_id
    AND event.event = 'skill.installed'
    AND event.resource_id = installed.name
    AND event.details->>'source' IN ('create-skill', 'biz')
)
OR EXISTS (
  SELECT 1
  FROM skill_install_requests request
  JOIN audit_logs event
    ON event.user_id = request.user_id
   AND event.event = 'skill.approval.approved'
   AND event.resource_id = request.id::text
  WHERE request.user_id = installed.user_id
    AND request.name = installed.name
    AND request.status = 'approved'
    AND request.source = 'biz'
);
