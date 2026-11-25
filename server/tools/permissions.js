import { pool } from '../db/pool.js'
import { audit } from '../observability/audit.js'
import { getTool } from './registry.js'

export async function hasToolPermissionGrant({ userId, tool, database }) {
  if (!tool.approvalScope) return false
  const { rowCount } = await database.query(
    `SELECT 1 FROM tool_permission_grants
     WHERE user_id = $1 AND tool_id = $2 AND scope = $3`,
    [userId, tool.id, tool.approvalScope],
  )
  return rowCount > 0
}

export async function insertToolPermissionGrant({ userId, tool, database }) {
  if (!tool.approvalScope) {
    throw Object.assign(new Error('This tool cannot be allowed for future workspace actions.'), { status: 400 })
  }
  await database.query(
    `INSERT INTO tool_permission_grants (user_id, tool_id, scope)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, tool_id, scope) DO NOTHING`,
    [userId, tool.id, tool.approvalScope],
  )
}

export async function listToolPermissionGrants({ userId, database = pool }) {
  const { rows } = await database.query(
    `SELECT tool_id, granted_at FROM tool_permission_grants
     WHERE user_id = $1 ORDER BY granted_at DESC`,
    [userId],
  )
  return rows
}

export async function revokeToolPermissionGrant({ userId, toolId, database = pool }) {
  const tool = getTool(toolId)
  if (!tool?.approvalScope) return false
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    const removed = await client.query(
      `DELETE FROM tool_permission_grants
       WHERE user_id = $1 AND tool_id = $2 AND scope = $3`,
      [userId, tool.id, tool.approvalScope],
    )
    if (!removed.rowCount) {
      await client.query('ROLLBACK')
      return false
    }
    await audit({
      userId,
      event: 'tool.permission.revoked',
      resourceType: 'tool_definition',
      resourceId: tool.id,
      details: { scope: tool.approvalScope },
    }, client)
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
