import test from 'node:test'
import assert from 'node:assert/strict'
import { getTool, registerTool } from './registry.js'
import { revokeToolPermissionGrant } from './permissions.js'

test('revoking a workspace permission deletes only the current user grant and writes an audit event', async () => {
  const toolId = 'test-permission-revoke'
  const unregister = registerTool({
    id: toolId,
    description: 'Tool used to test permission revocation.',
    inputSchema: { type: 'object', properties: {} },
    permissions: ['tool:approved'],
    approvalScope: 'workspace:test',
    validate: () => true,
    execute: async () => ({}),
  })
  const statements = []
  const database = {
    async connect() {
      return {
        async query(sql, values = []) {
          statements.push({ sql, values })
          if (sql.includes('DELETE FROM tool_permission_grants')) return { rowCount: 1, rows: [] }
          return { rowCount: 1, rows: [] }
        },
        release() {},
      }
    },
  }

  try {
    assert.equal(await revokeToolPermissionGrant({ userId: 'user-1', toolId, database }), true)
    const deletion = statements.find(({ sql }) => sql.includes('DELETE FROM tool_permission_grants'))
    assert.deepEqual(deletion.values, ['user-1', toolId, getTool(toolId).approvalScope])
    assert.ok(statements.some(({ sql, values }) => (
      sql.includes('INSERT INTO audit_logs') && values[1] === 'tool.permission.revoked'
    )))
    assert.ok(statements.some(({ sql }) => sql === 'COMMIT'))
  } finally {
    unregister()
  }
})

test('unknown or non-grantable tools cannot trigger permission deletion', async () => {
  assert.equal(await revokeToolPermissionGrant({
    userId: 'user-1',
    toolId: 'unknown-tool',
    database: { connect: async () => assert.fail('Unknown tools must not touch the database') },
  }), false)
})
