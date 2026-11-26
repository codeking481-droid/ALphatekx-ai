import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('initial migration defines isolated application data and encrypted credential columns', async () => {
  const migration = await readFile(new URL('./001_initial.sql', import.meta.url), 'utf8')
  for (const table of [
    '"user"', '"session"', '"account"', '"verification"', '"twoFactor"', 'user_settings',
    'conversations', 'messages', 'attachments', 'ai_providers', 'provider_configurations',
    'models', 'projects', 'tasks', 'agent_definitions', 'agent_runs', 'tool_definitions',
    'tool_executions', 'memory_records', 'approval_requests', 'audit_logs', 'integration_accounts', 'ai_usage_events',
  ]) {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${escaped}`))
  }
  assert.match(migration, /"twoFactorEnabled" BOOLEAN/)
  assert.match(migration, /"failedVerificationCount" INTEGER NOT NULL DEFAULT 0/)
  assert.match(migration, /"lockedUntil" TIMESTAMPTZ/)
  assert.match(migration, /encrypted_credentials BYTEA NOT NULL/)
  assert.match(migration, /REFERENCES "user"\("id"\) ON DELETE CASCADE/)
})

test('request observability migration adds correlation to AI usage without dropping data', async () => {
  const migration = await readFile(new URL('./002_request_observability.sql', import.meta.url), 'utf8')
  assert.match(migration, /ADD COLUMN IF NOT EXISTS request_id TEXT/)
  assert.match(migration, /CREATE INDEX IF NOT EXISTS ai_usage_request_idx/)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects\(id\) ON DELETE SET NULL/)
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN)|\bDELETE\s+FROM|\bTRUNCATE\b/i)
})

test('durable jobs migration adds restart-safe job state without destructive changes', async () => {
  const migration = await readFile(new URL('./003_durable_jobs.sql', import.meta.url), 'utf8')
  assert.match(migration, /CREATE TABLE IF NOT EXISTS jobs/)
  for (const column of ['status', 'input', 'result', 'progress', 'attempts', 'cancel_requested_at', 'lease_owner', 'lease_expires_at', 'heartbeat_at']) {
    assert.match(migration, new RegExp(`\\b${column}\\b`))
  }
  assert.match(migration, /CREATE INDEX IF NOT EXISTS jobs_claim_idx/)
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN)|\bDELETE\s+FROM|\bTRUNCATE\b/i)
})

test('tool permission grants are scoped to a user, tool, and workspace without destructive changes', async () => {
  const migration = await readFile(new URL('./004_tool_permission_grants.sql', import.meta.url), 'utf8')
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tool_permission_grants/)
  assert.match(migration, /PRIMARY KEY \(user_id, tool_id, scope\)/)
  assert.match(migration, /REFERENCES "user"\("id"\) ON DELETE CASCADE/)
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN)|\bDELETE\s+FROM|\bTRUNCATE\b/i)
})

test('open skills migration stores user-scoped enablement and pending approvals additively', async () => {
  const migration = await readFile(new URL('./005_open_skills.sql', import.meta.url), 'utf8')
  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_skills/)
  assert.match(migration, /PRIMARY KEY \(user_id, name\)/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS skill_install_requests/)
  assert.match(migration, /CHECK \(action IN \('install', 'enable'\)\)/)
  assert.match(migration, /REFERENCES "user"\("id"\) ON DELETE CASCADE/)
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN)|\bDELETE\s+FROM|\bTRUNCATE\b/i)
})

test('smart memory migration allows the four memory types without deleting existing records', async () => {
  const migration = await readFile(new URL('./006_smart_memory.sql', import.meta.url), 'utf8')
  for (const kind of ['fact', 'preference', 'project', 'lesson-learned']) {
    assert.match(migration, new RegExp(`'${kind}'`))
  }
  for (const legacyKind of ['conversation_context', 'project_context', 'task_history', 'agent_history']) {
    assert.match(migration, new RegExp(`'${legacyKind}'`))
  }
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN)|\bDELETE\s+FROM|\bTRUNCATE\b/i)
})

test('LinkedIn migration stores encrypted user credentials and short-lived approvals additively', async () => {
  const migration = await readFile(new URL('./007_linkedin_connections.sql', import.meta.url), 'utf8')
  assert.match(migration, /CREATE TABLE IF NOT EXISTS linkedin_connections/)
  assert.match(migration, /token_encrypted BYTEA NOT NULL/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS linkedin_oauth_states/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS linkedin_action_approvals/)
  assert.match(migration, /CHECK \(action IN \('post', 'reply'\)\)/)
  assert.match(migration, /REFERENCES "user"\("id"\) ON DELETE CASCADE/)
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN)|\bDELETE\s+FROM|\bTRUNCATE\b/i)
})

test('BYOK plan foundation and scheduled posts migrations are additive and user-scoped', async () => {
  const plan = await readFile(new URL('./008_mcp_byok_plan.sql', import.meta.url), 'utf8')
  const scheduledPosts = await readFile(new URL('./009_scheduled_linkedin_posts.sql', import.meta.url), 'utf8')
  assert.match(plan, /CREATE TABLE IF NOT EXISTS user_plans/)
  assert.match(plan, /plan TEXT NOT NULL DEFAULT 'free'/)
  assert.match(plan, /REFERENCES "user"\("id"\) ON DELETE CASCADE/)
  assert.match(scheduledPosts, /CREATE TABLE IF NOT EXISTS scheduled_linkedin_posts/)
  assert.match(scheduledPosts, /REFERENCES tool_executions\(id\) ON DELETE SET NULL/)
  assert.match(scheduledPosts, /CHECK \(status IN \('pending', 'publishing', 'published', 'failed', 'cancelled'\)\)/)
  for (const migration of [plan, scheduledPosts]) {
    assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN)|\bDELETE\s+FROM|\bTRUNCATE\b/i)
  }
})
