import { pool } from '../db/pool.js'
import { listTools } from './registry.js'

export async function syncToolDefinitions(database = pool) {
  for (const tool of listTools()) {
    await database.query(
      `INSERT INTO tool_definitions (id, description, input_schema, permissions, requires_approval)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       ON CONFLICT (id) DO UPDATE SET
         description = EXCLUDED.description,
         input_schema = EXCLUDED.input_schema,
         permissions = EXCLUDED.permissions,
         requires_approval = EXCLUDED.requires_approval,
         enabled = TRUE`,
      [
        tool.id,
        tool.description,
        JSON.stringify(tool.inputSchema),
        JSON.stringify(tool.permissions),
        tool.requiresApproval,
      ],
    )
  }
}
