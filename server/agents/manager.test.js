import test from 'node:test'
import assert from 'node:assert/strict'
import { assignAgentTask, completeAgentTask, waitAgentTaskForApproval } from './manager.js'

test('agent input is bounded and remains a JSON context object', async () => {
  let storedInput
  const database = {
    async query(sql, values) {
      if (sql.includes('INSERT INTO agent_runs')) {
        storedInput = values[3]
        return { rows: [{ id: 'run-1' }] }
      }
      return { rowCount: 1, rows: [] }
    },
  }
  const runId = await assignAgentTask({
    agentId: 'research-reasoning',
    userId: 'user-1',
    input: { request: 'analyze this' },
    database,
  })
  assert.equal(runId, 'run-1')
  assert.deepEqual(JSON.parse(storedInput), { request: 'analyze this' })
  await assert.rejects(
    assignAgentTask({
      agentId: 'research-reasoning',
      userId: 'user-1',
      input: { context: 'x'.repeat(65 * 1024) },
      database,
    }),
    (error) => error.status === 413,
  )
})

test('agent completion only transitions an active run to a terminal state', async () => {
  let query
  await completeAgentTask('run-1', {
    status: 'completed',
    result: { summary: 'done' },
    database: {
      async query(...args) {
        query = args
        return { rowCount: 1 }
      },
    },
  })

  assert.match(query[0], /WHERE id = \$1 AND status IN \('running', 'waiting_approval'\) RETURNING id/)
  assert.equal(query[1][1], 'completed')
})

test('agent completion reports stale or missing runs', async () => {
  await assert.rejects(
    completeAgentTask('run-1', {
      status: 'failed',
      database: { query: async () => ({ rowCount: 0 }) },
    }),
    (error) => error.status === 409,
  )
})

test('waiting approval is not treated as a completed agent run', async () => {
  await assert.rejects(
    completeAgentTask('run-1', {
      status: 'waiting_approval',
      database: { query: async () => assert.fail('Must reject before writing') },
    }),
    /Invalid terminal agent status/,
  )
})

test('agent runs persist the waiting-approval state before a decision', async () => {
  let query
  await waitAgentTaskForApproval('run-1', {
    async query(...args) {
      query = args
      return { rowCount: 1 }
    },
  })
  assert.match(query[0], /SET status = 'waiting_approval'/)
  assert.deepEqual(query[1], ['run-1'])
})
