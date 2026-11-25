import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTool } from '../tools/registry.js'
import { executePlanGraph } from './execution-engine.js'

function task(id, overrides = {}) {
  return {
    id,
    description: `Complete ${id}.`,
    type: 'analysis',
    requiredInputs: [{ kind: 'user_request', description: 'The current request.' }],
    dependencies: [],
    expectedOutput: `${id} result`,
    acceptanceCriteria: [`${id} output is present.`],
    riskClassification: 'low',
    requiredCapability: 'reasoning',
    specialistRole: 'general',
    maxAttempts: 2,
    completionConditions: [`${id} output is available.`],
    ...overrides,
  }
}

function verified(output, extra = {}) {
  return {
    status: 'verified',
    output,
    evidence: [{ kind: 'test_result' }],
    verification: { method: 'test_contract', scope: 'test', checks: ['output present'] },
    ...extra,
  }
}

test('executes a one-task plan through authorization, execution, and verification', async () => {
  const states = []
  const report = await executePlanGraph({
    planGraph: { tasks: [task('answer')] },
    dispatch: async (item, { onAuthorized, attempt }) => {
      onAuthorized({ agentId: 'research-reasoning', agentRunId: `run-${attempt}` })
      states.push({ id: item.id, attempt })
      return verified({ text: 'The answer.' })
    },
  })

  assert.equal(report.status, 'completed')
  assert.deepEqual(states, [{ id: 'answer', attempt: 1 }])
  assert.equal(report.tasks[0].status, 'verified')
  assert.deepEqual(report.tasks[0].transitions, ['proposed', 'authorized', 'executed', 'verified'])
  assert.equal(report.tasks[0].agentRunId, 'run-1')
})

test('runs independent tasks concurrently within the configured limit', async () => {
  let active = 0
  let maximumActive = 0
  const report = await executePlanGraph({
    planGraph: { tasks: [task('first'), task('second'), task('third')] },
    maxParallel: 2,
    dispatch: async (item, { onAuthorized }) => {
      onAuthorized({ agentId: 'research-reasoning', agentRunId: `run-${item.id}` })
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return verified(item.id)
    },
  })

  assert.equal(report.status, 'completed')
  assert.equal(maximumActive, 2)
})

test('dependent tasks wait for verified outputs and receive those outputs', async () => {
  const received = []
  const report = await executePlanGraph({
    planGraph: {
      tasks: [
        task('combine', {
          dependencies: ['source'],
          requiredInputs: [{ kind: 'task_output', description: 'Source result', sourceTaskId: 'source' }],
        }),
        task('source'),
      ],
    },
    dispatch: async (item, { dependencyOutputs, onAuthorized }) => {
      onAuthorized({ agentId: 'research-reasoning', agentRunId: `run-${item.id}` })
      received.push({ id: item.id, dependencyOutputs })
      return verified(item.id === 'source' ? { value: 4 } : { value: dependencyOutputs.source.value * 2 })
    },
  })

  assert.equal(report.status, 'completed')
  assert.deepEqual(received, [
    { id: 'source', dependencyOutputs: {} },
    { id: 'combine', dependencyOutputs: { source: { value: 4 } } },
  ])
})

test('failed dependencies block dependents while independent work can finish', async () => {
  const dispatched = []
  const report = await executePlanGraph({
    planGraph: {
      tasks: [
        task('source', { maxAttempts: 1 }),
        task('dependent', {
          dependencies: ['source'],
          requiredInputs: [{ kind: 'task_output', description: 'Source result', sourceTaskId: 'source' }],
        }),
        task('independent'),
      ],
    },
    dispatch: async (item, { onAuthorized }) => {
      dispatched.push(item.id)
      onAuthorized({ agentId: 'research-reasoning', agentRunId: `run-${item.id}` })
      if (item.id === 'source') throw new Error('Provider rejected task')
      return verified(item.id)
    },
  })

  assert.equal(report.status, 'failed')
  assert.deepEqual(dispatched.sort(), ['independent', 'source'])
  assert.equal(report.tasks.find((item) => item.taskId === 'dependent').status, 'blocked')
  assert.equal(report.tasks.find((item) => item.taskId === 'source').status, 'failed')
})

test('retries retryable failures only within the task and specialist budgets', async () => {
  let calls = 0
  const report = await executePlanGraph({
    planGraph: { tasks: [task('retry', { maxAttempts: 3 })] },
    dispatch: async (_item, { onAuthorized, attempt }) => {
      onAuthorized({ agentId: 'research-reasoning', agentRunId: `run-${attempt}` })
      calls += 1
      if (calls < 3) {
        const error = new Error('Transient provider error')
        error.retryable = true
        throw error
      }
      return verified('recovered')
    },
  })

  assert.equal(report.status, 'completed')
  assert.equal(calls, 3)
  assert.equal(report.tasks[0].attempts, 3)
  assert.equal(report.tasks[0].attemptFailures.length, 2)
})

test('approval-required tool tasks pause execution and block their dependents', async () => {
  const unregister = registerTool({
    id: 'execution-engine-approval-test',
    description: 'Mock action requiring approval.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    permissions: ['tool:approved'],
    validate: (input) => typeof input?.target === 'string',
    execute: async () => ({ accepted: true }),
  })
  try {
    let dispatches = 0
    const report = await executePlanGraph({
      planGraph: {
        tasks: [
          task('action', {
            type: 'tool',
            requiredInputs: [{ kind: 'tool_output', description: 'Action result', toolId: 'execution-engine-approval-test' }],
            requiredCapability: 'tool_execution',
            specialistRole: 'execution',
            toolInput: { target: 'account-1' },
          }),
          task('follow-up', {
            dependencies: ['action'],
            requiredInputs: [{ kind: 'task_output', description: 'Action output', sourceTaskId: 'action' }],
          }),
        ],
      },
      dispatch: async (_item, { onAuthorized }) => {
        dispatches += 1
        onAuthorized({ agentId: 'execution', agentRunId: 'run-action' })
        return { status: 'awaiting_approval', output: null, approvalId: 'approval-1', evidence: [{ kind: 'approval' }] }
      },
    })

    assert.equal(report.status, 'awaiting_approval')
    assert.equal(dispatches, 1)
    assert.equal(report.tasks[0].status, 'awaiting_approval')
    assert.deepEqual(report.tasks[0].transitions, ['proposed', 'authorized', 'awaiting_approval'])
    assert.equal(report.tasks[0].approvalId, 'approval-1')
    assert.equal(report.tasks[1].status, 'proposed')
  } finally {
    unregister()
  }
})

test('approved actions resume the stored graph and dispatch newly eligible dependents', async () => {
  const unregister = registerTool({
    id: 'execution-engine-resume-test',
    description: 'Mock action requiring approval.',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    permissions: ['tool:approved'],
    validate: (input) => typeof input?.target === 'string',
    execute: async () => ({ accepted: true }),
  })
  const planGraph = {
    tasks: [
      task('action', {
        type: 'tool',
        requiredInputs: [{ kind: 'tool_output', description: 'Action result', toolId: 'execution-engine-resume-test' }],
        requiredCapability: 'tool_execution',
        specialistRole: 'execution',
        toolInput: { target: 'account-2' },
      }),
      task('follow-up', {
        dependencies: ['action'],
        requiredInputs: [{ kind: 'task_output', description: 'Action output', sourceTaskId: 'action' }],
      }),
    ],
  }
  try {
    const paused = await executePlanGraph({
      planGraph,
      dispatch: async (_item, { onAuthorized }) => {
        onAuthorized({ agentId: 'execution', agentRunId: 'run-action' })
        return { status: 'awaiting_approval', output: null, approvalId: 'approval-2', evidence: [{ kind: 'approval' }] }
      },
    })
    const dispatched = []
    const resumed = await executePlanGraph({
      planGraph,
      initialReport: paused,
      approvedTaskResult: {
        taskId: 'action',
        status: 'verified',
        output: { accepted: true },
        verification: { method: 'registered_tool_verifier' },
        evidence: [{ kind: 'tool_execution', verified: true }],
        agentRunId: 'run-action',
      },
      dispatch: async (item, { onAuthorized, dependencyOutputs }) => {
        dispatched.push({ id: item.id, dependencyOutputs })
        onAuthorized({ agentId: 'research-reasoning', agentRunId: 'run-follow-up' })
        return verified('follow-up complete')
      },
    })
    assert.deepEqual(dispatched, [{ id: 'follow-up', dependencyOutputs: { action: { accepted: true } } }])
    assert.equal(resumed.status, 'completed')
    assert.deepEqual(resumed.tasks[0].transitions, [
      'proposed', 'authorized', 'awaiting_approval', 'authorized', 'executed', 'verified',
    ])
  } finally {
    unregister()
  }
})

test('uncertain tool outcomes are terminal and never retried', async () => {
  let attempts = 0
  const report = await executePlanGraph({
    planGraph: { tasks: [task('uncertain-action')] },
    dispatch: async (_item, { onAuthorized }) => {
      attempts += 1
      onAuthorized({ agentId: 'execution', agentRunId: `run-${attempts}` })
      const error = new Error('Tool outcome is unknown.')
      error.toolExecution = { id: 'tool-1', status: 'failed', uncertain: true }
      error.retryable = false
      throw error
    },
  })
  assert.equal(attempts, 1)
  assert.equal(report.status, 'uncertain')
  assert.equal(report.tasks[0].status, 'uncertain')
})

test('invalid verified results fail instead of satisfying dependencies', async () => {
  const report = await executePlanGraph({
    planGraph: { tasks: [task('invalid', { maxAttempts: 1 })] },
    dispatch: async (_item, { onAuthorized }) => {
      onAuthorized({ agentId: 'research-reasoning', agentRunId: 'run-invalid' })
      return {
        status: 'verified',
        output: 'unsubstantiated',
        evidence: [],
      }
    },
  })

  test('a structured failed result preserves its failure reason in task state', async () => {
    const report = await executePlanGraph({
      planGraph: { tasks: [task('reported-failure', { maxAttempts: 1 })] },
      dispatch: async (_item, { onAuthorized }) => {
        onAuthorized({ agentId: 'research-reasoning', agentRunId: 'run-failure' })
        return {
          status: 'failed',
          output: null,
          error: 'Required source data was not available.',
          evidence: [],
        }
      },
    })

    assert.equal(report.status, 'failed')
    assert.equal(report.tasks[0].status, 'failed')
    assert.equal(report.tasks[0].error, 'Required source data was not available.')
  })

  assert.equal(report.status, 'failed')
  assert.equal(report.tasks[0].status, 'failed')
  assert.match(report.tasks[0].error, /no verification evidence/)
})

test('interruption stops queued work and preserves already completed task evidence', async () => {
  const controller = new AbortController()
  const report = await executePlanGraph({
    planGraph: { tasks: [task('active'), task('queued')] },
    dispatch: async (item, { onAuthorized }) => {
      onAuthorized({ agentId: 'research-reasoning', agentRunId: `run-${item.id}` })
      if (item.id === 'active') controller.abort(new Error('User cancelled.'))
      return verified(item.id)
    },
    signal: controller.signal,
  })

  assert.equal(report.status, 'interrupted')
  assert.equal(report.tasks[0].status, 'verified')
  assert.equal(report.tasks[1].status, 'interrupted')
})
