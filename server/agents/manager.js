import { pool } from '../db/pool.js'
import { AGENT_DEFINITIONS } from './definitions.js'

export async function assignAgentTask({ agentId, userId, taskId = null, input, database = pool }) {
  const definition = AGENT_DEFINITIONS.find((agent) => agent.id === agentId)
  if (!definition) throw new Error(`Unknown agent "${agentId}".`)
  const serializedInput = serializeAgentInput(input)
  if (taskId) {
    const task = await database.query('SELECT 1 FROM tasks WHERE id = $1 AND user_id = $2', [taskId, userId])
    if (!task.rowCount) throw Object.assign(new Error('Task not found.'), { status: 404 })
  }
  await database.query(
    `INSERT INTO agent_definitions (id, name, role, permissions)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, permissions = EXCLUDED.permissions`,
    [definition.id, definition.name, definition.role, JSON.stringify(definition.permissions)],
  )
  const { rows } = await database.query(
    `INSERT INTO agent_runs (agent_id, user_id, task_id, status, input, started_at)
     VALUES ($1, $2, $3, 'running', $4::jsonb, now()) RETURNING id`,
    [agentId, userId, taskId, serializedInput],
  )
  return rows[0].id
}

export async function completeAgentTask(runId, { status, result = null, error = null, database = pool }) {
  if (!['completed', 'failed', 'cancelled'].includes(status)) {
    throw new Error(`Invalid terminal agent status "${status}".`)
  }
  const serializedResult = serializeOptionalPayload(result, 'Agent result')
  const serializedError = serializeOptionalPayload(error, 'Agent error')
  const updated = await database.query(
    `UPDATE agent_runs SET status = $2, result = $3::jsonb, error = $4::jsonb, completed_at = now()
     WHERE id = $1 AND status IN ('running', 'waiting_approval') RETURNING id`,
    [runId, status, serializedResult, serializedError],
  )
  if (!updated.rowCount) {
    throw Object.assign(new Error('Agent run is not active or no longer exists.'), { status: 409 })
  }
}

export async function waitAgentTaskForApproval(runId, database = pool) {
  const updated = await database.query(
    `UPDATE agent_runs SET status = 'waiting_approval'
     WHERE id = $1 AND status = 'running' RETURNING id`,
    [runId],
  )
  if (!updated.rowCount) {
    throw Object.assign(new Error('Agent run is not active or no longer exists.'), { status: 409 })
  }
}

function serializeAgentInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Agent input must be a JSON object.'), { status: 400 })
  }
  let serialized
  try {
    serialized = JSON.stringify(input)
  } catch (cause) {
    throw Object.assign(new Error('Agent input must be JSON serializable.', { cause }), { status: 400 })
  }
  if (typeof serialized !== 'string') {
    throw Object.assign(new Error('Agent input must serialize to a JSON object.'), { status: 400 })
  }
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    throw Object.assign(new Error('Agent input exceeds the 64 KB context limit.'), { status: 413 })
  }
  return serialized
}

function serializeOptionalPayload(value, label) {
  if (value === null) return null
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch (cause) {
    throw Object.assign(new Error(`${label} must be JSON serializable.`, { cause }), { status: 400 })
  }
  if (typeof serialized !== 'string') {
    throw Object.assign(new Error(`${label} must be JSON serializable.`), { status: 400 })
  }
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    throw Object.assign(new Error(`${label} must not exceed the 64 KB context limit.`), { status: 413 })
  }
  return serialized
}
