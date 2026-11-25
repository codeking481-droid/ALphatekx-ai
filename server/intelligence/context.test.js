import test from 'node:test'
import assert from 'node:assert/strict'
import { retrieveContext } from './context.js'

test('context retrieval includes global and only the selected owned project memory', async () => {
  const calls = []
  const database = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.includes('FROM projects')) return { rowCount: 1, rows: [{}] }
      if (sql.includes('FROM messages')) return { rows: [] }
      return { rows: [
        { project_id: null, kind: 'preference', content: 'Use concise answers.', source: 'settings' },
        { project_id: 'project-1', kind: 'project_context', content: 'Keep costs low.', source: 'project' },
      ] }
    },
  }

  const context = await retrieveContext({
    userId: 'user-1',
    projectId: 'project-1',
    database,
  })

  const memoriesQuery = calls.find(({ sql }) => sql.includes('FROM memory_records'))
  assert.deepEqual(memoriesQuery.params, ['user-1', 'project-1'])
  assert.match(memoriesQuery.sql, /project_id IS NULL OR project_id = \$2/)
  assert.equal(context.memories.length, 2)
  assert.equal(context.globalMemories.length, 1)
  assert.equal(context.projectMemories.length, 1)
  assert.equal(context.projectId, 'project-1')
})

test('retrieval keeps global preferences and selects keyword-relevant memories', async () => {
  const memories = [
    { project_id: null, kind: 'preference', content: 'Likes simple English', source: 'chat:auto' },
    { project_id: null, kind: 'fact', content: 'Business: SkinSnap', source: 'chat:auto' },
    { project_id: null, kind: 'fact', content: 'Works as a graphic designer', source: 'chat:auto' },
  ]
  const context = await retrieveContext({
    userId: 'user-1',
    message: 'Write about SkinSnap',
    database: {
      async query(sql) {
        if (sql.includes('FROM memory_records')) return { rows: memories }
        return { rows: [] }
      },
    },
  })

  assert.deepEqual(context.globalMemories.map(({ content }) => content), [
    'Likes simple English',
    'Business: SkinSnap',
  ])
})

test('context retrieval rejects a project not owned by the user', async () => {
  const database = {
    async query(sql) {
      if (sql.includes('FROM projects')) return { rowCount: 0, rows: [] }
      assert.fail('Must not retrieve context for an unowned project')
    },
  }

  await assert.rejects(
    retrieveContext({ userId: 'user-1', projectId: 'other-project', database }),
    (error) => error.status === 404,
  )
})

test('conversation context retains its project scope when no project is supplied', async () => {
  const calls = []
  const database = {
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.includes('FROM conversations')) return { rowCount: 1, rows: [{ project_id: 'project-1' }] }
      if (sql.includes('FROM projects')) return { rowCount: 1, rows: [{}] }
      if (sql.includes('FROM messages')) return { rows: [] }
      return { rows: [] }
    },
  }
  const context = await retrieveContext({ userId: 'user-1', conversationId: 'conversation-1', database })
  const memoryQuery = calls.find(({ sql }) => sql.includes('FROM memory_records'))
  assert.deepEqual(memoryQuery.params, ['user-1', 'project-1'])
  assert.equal(context.projectMemories.length, 0)
  assert.equal(context.projectId, 'project-1')
})

test('conversation cannot be reused under a different project context', async () => {
  const database = {
    async query(sql) {
      if (sql.includes('FROM conversations')) return { rowCount: 1, rows: [{ project_id: 'project-1' }] }
      assert.fail('Must reject before retrieving the remaining context')
    },
  }
  await assert.rejects(
    retrieveContext({
      userId: 'user-1',
      conversationId: 'conversation-1',
      projectId: 'project-2',
      database,
    }),
    (error) => error.status === 409,
  )
})
