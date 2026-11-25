import { pool } from '../db/pool.js'

export async function audit({ userId = null, event, resourceType = null, resourceId = null, details = {} }, database = pool) {
  await database.query(
    `INSERT INTO audit_logs (user_id, event, resource_type, resource_id, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, event, resourceType, resourceId, JSON.stringify(details)],
  )
}
