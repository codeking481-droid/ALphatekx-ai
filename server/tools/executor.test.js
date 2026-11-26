import test from 'node:test'
import assert from 'node:assert/strict'
import { decideApproval, executeTool } from './executor.js'
import { registerTool } from './registry.js'
import { registerLinkedInTools } from '../linkedin/tools.js'

function createTool(id) {
  return registerTool({
    id,
    description: 'Test action requiring an authorized agent.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    permissions: ['tool:approved'],
    validate: (input) => typeof input?.value === 'string',
    execute: async () => ({ completed: true }),
  })
}

function createApprovalDatabase(toolId = 'test-approval-decision') {
  const state = {
    approvalStatus: 'pending',
    toolStatus: 'pending_approval',
    agentStatus: 'running',
    result: null,
    grants: [],
    audits: [],
  }
  const database = {
    state,
    async connect() {
      return {
        async query(sql, values = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] }
          if (sql.includes('SELECT a.id, a.tool_execution_id')) {
            if (state.approvalStatus !== 'pending' || state.agentStatus !== 'running') return { rowCount: 0, rows: [] }
            return {
              rowCount: 1,
              rows: [{
                id: 'approval-1',
                tool_execution_id: 'execution-1',
                tool_id: toolId,
                input: { value: 'approved' },
                agent_run_id: 'run-1',
                agent_status: state.agentStatus,
              }],
            }
          }
          if (sql.includes('UPDATE approval_requests')) {
            state.approvalStatus = values[1]
            return { rowCount: 1, rows: [] }
          }
          if (sql.includes('UPDATE tool_executions SET status')) {
            state.toolStatus = values[1]
            return { rowCount: 1, rows: [] }
          }
          if (sql.includes('INSERT INTO tool_permission_grants')) {
            state.grants.push(values)
            return { rowCount: 1, rows: [] }
          }
          if (sql.includes('INSERT INTO audit_logs')) {
            state.audits.push(values)
            return { rowCount: 1, rows: [] }
          }
          assert.fail(`Unexpected transaction query: ${sql}`)
        },
        release() {},
      }
    },
    async query(sql, values = []) {
      if (sql.includes('INSERT INTO audit_logs')) {
        state.audits.push(values)
        return { rowCount: 1, rows: [] }
      }
      if (sql.includes('UPDATE tool_executions SET status') && sql.includes('started_at')) {
        if (state.toolStatus !== 'queued') return { rowCount: 0, rows: [] }
        state.toolStatus = values[1]
        return { rowCount: 1, rows: [] }
      }
      if (sql.includes('UPDATE tool_executions SET status') && sql.includes('result =')) {
        state.toolStatus = values[1]
        state.result = JSON.parse(values[2])
        return { rowCount: 1, rows: [] }
      }
      if (sql.includes('UPDATE agent_runs SET status')) {
        state.agentStatus = values[1]
        return { rowCount: 1, rows: [{ id: 'run-1' }] }
      }
      assert.fail(`Unexpected database query: ${sql}`)
    },
  }
  return database
}

test('tool execution requires an agent run', async () => {
  const unregister = createTool('test-no-agent')
  try {
    await assert.rejects(
      executeTool({
        toolId: 'test-no-agent',
        userId: 'user-1',
        input: { value: 'x' },
        database: { connect: async () => assert.fail('Must reject before connecting') },
      }),
      (error) => error.status === 403,
    )
  } finally {
    unregister()
  }
})

test('tool input must satisfy its registered schema before database work begins', async () => {
  const unregister = registerTool({
    id: 'test-schema-validation',
    description: 'Tool with a required schema property.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    permissions: ['tool:approved'],
    validate: () => true,
    execute: async () => ({ completed: true }),
  })
  try {
    await assert.rejects(
      executeTool({
        toolId: 'test-schema-validation',
        userId: 'user-1',
        agentRunId: 'run-1',
        input: { unexpected: true },
        database: { connect: async () => assert.fail('Invalid input must be rejected before connecting') },
      }),
      (error) => error.status === 400 && /schema/.test(error.message),
    )
  } finally {
    unregister()
  }
})

test('agent permissions are checked before tool execution is recorded', async () => {
  const unregister = createTool('test-permission')
  let insertedExecution = false
  const database = {
    async connect() {
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0 }
          if (sql.includes('FROM agent_runs')) {
            return { rows: [{ status: 'running', permissions: ['tool:read'] }] }
          }
          if (sql.includes('INSERT INTO tool_executions')) insertedExecution = true
          return { rows: [], rowCount: 0 }
        },
        release() {},
      }
    },
  }

  try {
    await assert.rejects(
      executeTool({
        toolId: 'test-permission',
        userId: 'user-1',
        agentRunId: 'run-1',
        input: { value: 'x' },
        database,
      }),
      (error) => error.status === 403,
    )
    assert.equal(insertedExecution, false)
  } finally {
    unregister()
  }
})

test('LinkedIn posts still require a fresh approval even when a permission grant exists', async () => {
  const unregister = registerLinkedInTools()
  let approvalCreated = false
  const database = {
    async connect() {
      return {
        async query(sql) {
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] }
          if (sql.includes('FROM agent_runs')) {
            return { rowCount: 1, rows: [{ status: 'running', permissions: ['tool:approved'] }] }
          }
          if (sql.includes('FROM tool_permission_grants')) return { rowCount: 1, rows: [{}] }
          if (sql.includes('SELECT id, status FROM tool_executions')) return { rowCount: 0, rows: [] }
          if (sql.includes('INSERT INTO tool_executions')) return { rowCount: 1, rows: [{ id: 'execution-1' }] }
          if (sql.includes('INSERT INTO approval_requests')) {
            approvalCreated = true
            return { rowCount: 1, rows: [{ id: 'approval-1' }] }
          }
          if (sql.includes('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] }
          assert.fail(`Unexpected query: ${sql}`)
        },
        release() {},
      }
    },
  }

  try {
    const execution = await executeTool({
      toolId: 'linkedin_post',
      userId: 'user-1',
      agentRunId: 'run-1',
      input: { text: 'A draft that must be approved.' },
      database,
    })
    assert.equal(execution.status, 'pending_approval')
    assert.equal(approvalCreated, true)
  } finally {
    unregister.forEach((remove) => remove())
  }
})

test('duplicate tool calls for the same agent run are rejected before recording another execution', async () => {
  let executions = 0
  const unregister = registerTool({
    id: 'test-duplicate-execution',
    description: 'Tool call used to test duplicate prevention.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    permissions: ['tool:approved'],
    validate: (input) => typeof input?.value === 'string',
    execute: async () => {
      executions += 1
      return { completed: true }
    },
  })
  let inserted = false
  const database = {
    async connect() {
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0 }
          if (sql.includes('FROM agent_runs')) {
            return { rowCount: 1, rows: [{ status: 'running', permissions: ['tool:approved'] }] }
          }
          if (sql.includes('FROM tool_executions')) {
            return { rowCount: 1, rows: [{ id: 'execution-existing', status: 'completed' }] }
          }
          if (sql.includes('INSERT INTO tool_executions')) inserted = true
          return { rowCount: 0, rows: [] }
        },
        release() {},
      }
    },
  }
  try {
    await assert.rejects(
      executeTool({
        toolId: 'test-duplicate-execution',
        userId: 'user-1',
        agentRunId: 'run-1',
        input: { value: 'x' },
        database,
      }),
      (error) => error.status === 409 && error.executionStatus === 'completed',
    )
    assert.equal(inserted, false)
    assert.equal(executions, 0)
  } finally {
    unregister()
  }
})

test('approval decisions finish the associated agent run with executed or cancelled evidence', async () => {
  let executions = 0
  const unregister = registerTool({
    id: 'test-approval-decision',
    description: 'Action requiring user approval.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    permissions: ['tool:approved'],
    validate: (input) => typeof input?.value === 'string',
    execute: async () => {
      executions += 1
      return { accepted: true }
    },
  })
  try {
    const approvedDatabase = createApprovalDatabase()
    const approved = await decideApproval({
      userId: 'user-1',
      approvalId: 'approval-1',
      decision: 'approved',
      database: approvedDatabase,
    })
    assert.equal(approved.status, 'completed')
    assert.equal(approved.executionId, 'execution-1')
    assert.equal(approvedDatabase.state.agentStatus, 'completed')
    assert.equal(executions, 1)

    const deniedDatabase = createApprovalDatabase()
    const denied = await decideApproval({
      userId: 'user-1',
      approvalId: 'approval-1',
      decision: 'denied',
      database: deniedDatabase,
    })
    assert.equal(denied.status, 'denied')
    assert.equal(deniedDatabase.state.agentStatus, 'cancelled')
    assert.equal(executions, 1)
  } finally {
    unregister()
  }
})

test('deferred approval records a decision without executing the tool in the API process', async () => {
  let executions = 0
  const unregister = registerTool({
    id: 'test-approval-decision',
    description: 'Read-only action deferred to a worker.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    permissions: ['tool:approved'],
    validate: (input) => typeof input?.value === 'string',
    execute: async () => {
      executions += 1
      return { accepted: true }
    },
  })

  test('approval can grant and audit a persistent workspace-scoped file-write permission', async () => {
    const toolId = 'test-approval-remember'
    const unregister = registerTool({
      id: toolId,
      description: 'Workspace write used to test remembered approval.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      permissions: ['tool:approved'],
      approvalScope: 'workspace:test-scope',
      validate: (input) => typeof input?.value === 'string',
      execute: async () => ({ accepted: true }),
    })
    try {
      const database = createApprovalDatabase(toolId)
      const result = await decideApproval({
        userId: 'user-1',
        approvalId: 'approval-1',
        decision: 'approved',
        database,
        deferExecution: true,
        rememberForWorkspace: true,
      })
      assert.equal(result.status, 'queued')
      assert.deepEqual(database.state.grants[0], ['user-1', toolId, 'workspace:test-scope'])
      assert.ok(database.state.audits.some((values) => (
        values[1] === 'tool.permission.granted' &&
        JSON.parse(values[4]).scope === 'workspace:test-scope'
      )))
    } finally {
      unregister()
    }
  })

  test('remembered workspace permission skips repeat approval but retains permission checks and audit', async () => {
    let executions = 0
    let recordedStatus
    const auditEvents = []
    const unregister = registerTool({
      id: 'test-granted-workspace-write',
      description: 'Workspace write used to test persistent grants.',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      permissions: ['tool:approved'],
      approvalScope: 'workspace:test-scope',
      validate: (input) => typeof input?.value === 'string',
      execute: async () => {
        executions += 1
        return { accepted: true }
      },
    })
    const database = {
      async connect() {
        return {
          async query(sql, values = []) {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] }
            if (sql.includes('FROM agent_runs')) {
              return { rowCount: 1, rows: [{ status: 'running', permissions: ['tool:approved'] }] }
            }
            if (sql.includes('FROM tool_permission_grants')) return { rowCount: 1, rows: [{}] }
            if (sql.includes('FROM tool_executions')) return { rowCount: 0, rows: [] }
            if (sql.includes('INSERT INTO tool_executions')) {
              recordedStatus = values[3]
              return { rowCount: 1, rows: [{ id: 'granted-execution' }] }
            }
            if (sql.includes('INSERT INTO audit_logs')) {
              auditEvents.push(values)
              return { rowCount: 1, rows: [] }
            }
            assert.fail(`Unexpected transaction query: ${sql}`)
          },
          release() {},
        }
      },
      async query(sql, values = []) {
        if (sql.includes('started_at')) return { rowCount: 1, rows: [{ id: 'granted-execution' }] }
        if (sql.includes('result =')) return { rowCount: 1, rows: [] }
        assert.fail(`Unexpected database query: ${sql}`)
      },
    }

    try {
      const result = await executeTool({
        toolId: 'test-granted-workspace-write',
        userId: 'user-1',
        agentRunId: 'run-1',
        input: { value: 'write' },
        database,
      })
      assert.equal(result.status, 'completed')
      assert.equal(recordedStatus, 'queued')
      assert.equal(executions, 1)
      assert.equal(auditEvents[0][1], 'tool.execution.requested')
      assert.equal(JSON.parse(auditEvents[0][4]).approval_required, false)
    } finally {
      unregister()
    }
  })
  try {
    const database = createApprovalDatabase()
    const result = await decideApproval({
      userId: 'user-1',
      approvalId: 'approval-1',
      decision: 'approved',
      database,
      deferExecution: true,
    })
    assert.equal(result.status, 'queued')
    assert.equal(database.state.toolStatus, 'queued')
    assert.equal(database.state.agentStatus, 'running')
    assert.equal(executions, 0)
  } finally {
    unregister()
  }
})

test('tool timeouts are marked uncertain, never retry-safe, and reconciled if a late result arrives', async () => {
  const state = { execution: null }
  const auditEvents = []
  let executions = 0
  const unregister = registerTool({
    id: 'test-tool-timeout',
    description: 'Slow action used to test timeout reconciliation.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    permissions: ['tool:approved'],
    requiresApproval: false,
    retrySafe: true,
    timeoutMs: 5,
    validate: (input) => typeof input?.value === 'string',
    execute: async () => {
      executions += 1
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { accepted: true }
    },
  })
  const database = {
    async connect() {
      return {
        async query(sql, values = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] }
          if (sql.includes('INSERT INTO audit_logs')) {
            auditEvents.push(values)
            return { rowCount: 1, rows: [] }
          }
          if (sql.includes('FROM agent_runs')) {
            return { rowCount: 1, rows: [{ status: 'running', permissions: ['tool:approved'] }] }
          }
          if (sql.includes('FROM tool_executions')) {
            return state.execution
              ? { rowCount: 1, rows: [{ id: state.execution.id, status: state.execution.status }] }
              : { rowCount: 0, rows: [] }
          }
          if (sql.includes('INSERT INTO tool_executions')) {
            state.execution = {
              id: 'timeout-execution',
              agentRunId: values[2],
              toolId: values[0],
              input: JSON.parse(values[4]),
              status: values[3],
            }
            return { rowCount: 1, rows: [{ id: state.execution.id }] }
          }
          assert.fail(`Unexpected transaction query: ${sql}`)
        },
        release() {},
      }
    },
    async query(sql, values = []) {
      if (sql.includes('started_at')) {
        state.execution.status = values[1]
        return { rowCount: 1, rows: [{ id: state.execution.id }] }
      }
      if (sql.includes("status = 'failed'") && sql.includes("status = 'completed'")) {
        state.execution.status = 'completed'
        state.execution.result = JSON.parse(values[1])
        return { rowCount: 1, rows: [] }
      }
      if (sql.includes('SET status = $2, error =')) {
        state.execution.status = values[1]
        state.execution.error = JSON.parse(values[2])
        return { rowCount: 1, rows: [] }
      }
      assert.fail(`Unexpected database query: ${sql}`)
    },
  }

  try {
    await assert.rejects(
      executeTool({
        toolId: 'test-tool-timeout',
        userId: 'user-1',
        agentRunId: 'run-1',
        input: { value: 'x' },
        database,
      }),
      (error) => error.toolExecution?.uncertain === true && error.retryable === false,
    )
    assert.equal(state.execution.status, 'failed')
    await assert.rejects(
      executeTool({
        toolId: 'test-tool-timeout',
        userId: 'user-1',
        agentRunId: 'run-1',
        input: { value: 'x' },
        database,
      }),
      (error) => error.status === 409 && error.executionStatus === 'failed',
    )
    assert.equal(executions, 1)
    assert.equal(auditEvents.length, 1)
    assert.equal(auditEvents[0][0], 'user-1')
    assert.equal(auditEvents[0][1], 'tool.execution.requested')
    assert.equal(JSON.parse(auditEvents[0][4]).tool_id, 'test-tool-timeout')
    await new Promise((resolve) => setTimeout(resolve, 35))
    assert.equal(state.execution.status, 'completed')
    assert.deepEqual(state.execution.result, { accepted: true })
  } finally {
    unregister()
  }
})
