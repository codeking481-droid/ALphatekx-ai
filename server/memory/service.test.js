import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemory, deleteAllMemories, deleteMemory, updateMemory } from './service.js'

test('memory creation rejects malformed content before persistence', async () => {
  let called = false
  await assert.rejects(
    createMemory({
      userId: 'user-1',
      kind: 'preference',
      content: { unexpected: true },
      source: 'settings',
      database: { query: async () => { called = true } },
    }),
    (error) => error.status === 400,
  )
  assert.equal(called, false)
})

test('memory deletion is constrained to its owner', async () => {
  let parameters
  const deleted = await deleteMemory('user-1', 'memory-1', {
    async query(sql, values) {
      assert.match(sql, /WHERE id = \$1 AND user_id = \$2/)
      parameters = values
      return { rowCount: 0 }
    },
  })
  assert.deepEqual(parameters, ['memory-1', 'user-1'])
  assert.equal(deleted, false)
})

test('memory creation rejects secrets and unsupported types', async () => {
  const database = { query: async () => assert.fail('Sensitive memory must not be persisted') }
  await assert.rejects(
    createMemory({ userId: 'user-1', kind: 'fact', content: 'My API key is abc123', source: 'chat', database }),
    (error) => error.status === 400 && /sensitive/.test(error.message),
  )
  await assert.rejects(
    createMemory({ userId: 'user-1', kind: 'unknown', content: 'A useful fact', source: 'chat', database }),
    (error) => error.status === 400,
  )
})

test('memory edits are owner-scoped and reject sensitive replacement content', async () => {
  const calls = []
  const database = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (sql.includes('SELECT kind, content, project_id')) {
        return { rows: [{ kind: 'fact', content: 'Works in the UK', project_id: null }] }
      }
      if (sql.includes('UPDATE memory_records')) {
        return { rows: [{ id: values[0], kind: values[2], content: values[3], project_id: values[4] }] }
      }
      return { rowCount: 0, rows: [] }
    },
  }
  const updated = await updateMemory({ userId: 'user-1', memoryId: 'memory-1', content: 'Sells in the UK', database })
  assert.equal(updated.content, 'Sells in the UK')
  assert.deepEqual(calls[0].values, ['memory-1', 'user-1'])
  await assert.rejects(
    updateMemory({ userId: 'user-1', memoryId: 'memory-1', content: 'Password: abc123', database }),
    (error) => error.status === 400,
  )
})

test('delete all memories is scoped to the current user', async () => {
  let parameters
  const count = await deleteAllMemories('user-1', {
    async query(sql, values) {
      assert.match(sql, /DELETE FROM memory_records WHERE user_id = \$1/)
      parameters = values
      return { rowCount: 3 }
    },
  })
  assert.deepEqual(parameters, ['user-1'])
  assert.equal(count, 3)
})
