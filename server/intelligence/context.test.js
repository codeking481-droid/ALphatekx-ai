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

test("conversation context identifies Biz's unanswered question and the request it followed", async () => {
  const database = {
    async query(sql) {
      if (sql.includes('FROM conversations')) return { rowCount: 1, rows: [{ project_id: null }] }
      if (sql.includes('FROM messages')) {
        return {
          rows: [
            { role: 'assistant', content: 'When should the launch happen?' },
            { role: 'user', content: 'Help me plan the product launch.' },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const context = await retrieveContext({ userId: 'user-1', conversationId: 'conversation-1', database })

  assert.deepEqual(context.pendingQuestion, {
    question: 'When should the launch happen?',
    previousUserMessage: 'Help me plan the product launch.',
  })
})

test('conversation context does not carry an old question after the user has replied', async () => {
  const database = {
    async query(sql) {
      if (sql.includes('FROM conversations')) return { rowCount: 1, rows: [{ project_id: null }] }
      if (sql.includes('FROM messages')) {
        return {
          rows: [
            { role: 'user', content: 'Launch it next Friday.' },
            { role: 'assistant', content: 'When should the launch happen?' },
            { role: 'user', content: 'Help me plan the product launch.' },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const context = await retrieveContext({ userId: 'user-1', conversationId: 'conversation-1', database })

  assert.equal(context.pendingQuestion, null)
})

test('answered card metadata and the active task survive later conversation turns', async () => {
  const activeTask = {
    version: 1,
    kind: 'linkedin_recurring',
    status: 'awaiting_approval',
    originalRequest: 'Post this to LinkedIn every day for one week.',
    approvalId: 'approval-1',
    skill: { name: 'manage-linkedin', version: '1.0.0' },
    answers: [{
      question_id: 'question-1:q1',
      question_text: 'Should I use the same text 7 times, or make 7 different versions?',
      option_clicked: 'Use a sensible default',
      answer_text: 'Use a sensible default',
    }],
  }
  const database = {
    async query(sql) {
      if (sql.includes('FROM conversations')) return { rowCount: 1, rows: [{ project_id: null }] }
      if (sql.includes('FROM messages')) {
        return {
          rows: [
            { id: 'assistant-2', role: 'assistant', content: 'Drafts are waiting in Approvals.', metadata: { activeTask } },
            { id: 'user-2', role: 'user', content: '1. Same text or different versions: Use a sensible default', metadata: { clarificationAnswers: activeTask.answers } },
            { id: 'assistant-1', role: 'assistant', content: 'Should I use the same text 7 times, or make 7 different versions?', metadata: {} },
            { id: 'user-1', role: 'user', content: activeTask.originalRequest, metadata: {} },
          ],
        }
      }
      return { rows: [] }
    },
  }

  const context = await retrieveContext({ userId: 'user-1', conversationId: 'conversation-1', database })

  assert.equal(context.pendingQuestion, null)
  assert.equal(context.activeTask.approvalId, 'approval-1')
  assert.equal(context.activeTask.skill.name, 'manage-linkedin')
  assert.equal(context.activeTask.answers[0].option_clicked, 'Use a sensible default')
  assert.deepEqual(context.messages[2].metadata.clarificationAnswers, activeTask.answers)
})

test('pending LinkedIn approval recovers active drafts for legacy conversations', async () => {
  const toolInput = {
    text: 'Original post',
    schedule: {
      mode: 'recurring',
      scheduledAt: '2026-11-26T16:00:00.000Z',
      timezone: 'America/Chicago',
      count: 7,
      intervalMinutes: 1440,
      sameText: false,
      texts: Array.from({ length: 7 }, (_value, index) => `Draft ${index + 1}`),
    },
  }
  const database = {
    async query(sql, params) {
      if (sql.includes('FROM conversations')) return { rowCount: 1, rows: [{ project_id: null }] }
      if (sql.includes('FROM messages')) {
        return {
          rows: [
            { id: 'assistant-2', role: 'assistant', content: 'Drafts are waiting in Approvals.', metadata: { skill: { name: 'manage-linkedin' } } },
            { id: 'user-2', role: 'user', content: '1. Should I use the same text 7 times, or make 7 different versions?: Use a sensible default', metadata: {} },
            { id: 'assistant-1', role: 'assistant', content: 'Should I use the same text 7 times, or make 7 different versions?', metadata: {} },
            { id: 'user-1', role: 'user', content: 'Post this to LinkedIn every day at 10am for one week.', metadata: {} },
          ],
        }
      }
      if (sql.includes('FROM jobs j')) {
        assert.deepEqual(params, ['conversation-1', 'user-1'])
        return {
          rows: [{
            approval_id: 'approval-old',
            tool_input: toolInput,
            continuation: {
            request: '1. Should I use the same post text 7 times?: Use a sensible default',
            contextMessages: [
              { role: 'user', content: 'Post this to LinkedIn every day at 10am for one week.' },
              { role: 'user', content: '1. Should I use the same post text 7 times?: Use a sensible default' },
            ],
            skill: { name: 'manage-linkedin', version: '1.0.0' },
            },
          }],
        }
      }
      return { rows: [] }
    },
  }

  const context = await retrieveContext({ userId: 'user-1', conversationId: 'conversation-1', database })

  assert.equal(context.activeTask.status, 'awaiting_approval')
  assert.equal(context.activeTask.approvalId, 'approval-old')
  assert.deepEqual(context.activeTask.toolInput, toolInput)
  assert.equal(context.activeTask.skill.name, 'manage-linkedin')
  assert.equal(context.activeTask.originalRequest, 'Post this to LinkedIn every day at 10am for one week.')
  assert.equal(context.activeTask.answers[0].option_clicked, 'Use a sensible default')
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
