import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTool } from '../tools/registry.js'
import { topologicalOrder, validatePlanGraph } from './plan-graph.js'

function task(id, overrides = {}) {
  return {
    id,
    description: `Complete ${id}.`,
    type: 'analysis',
    requiredInputs: [{ kind: 'user_request', description: 'The user request.' }],
    dependencies: [],
    expectedOutput: `${id} findings`,
    acceptanceCriteria: [`${id} findings address the task.`],
    riskClassification: 'low',
    requiredCapability: 'reasoning',
    specialistRole: 'general',
    maxAttempts: 2,
    completionConditions: [`${id} findings are available.`],
    ...overrides,
  }
}

test('valid graphs retain independent tasks and order dependent tasks topologically', () => {
  const graph = validatePlanGraph({
    tasks: [
      task('combine', {
        dependencies: ['audience', 'budget'],
        requiredInputs: [
          { kind: 'task_output', description: 'Audience analysis', sourceTaskId: 'audience' },
          { kind: 'task_output', description: 'Budget analysis', sourceTaskId: 'budget' },
        ],
      }),
      task('audience'),
      task('budget'),
    ],
  })

  assert.deepEqual(topologicalOrder(graph).map(({ id }) => id), ['audience', 'budget', 'combine'])
  assert.deepEqual(graph.tasks[1].dependencies, [])
  assert.deepEqual(graph.tasks[2].dependencies, [])
})

test('graph validation rejects cyclic and missing dependencies', () => {
  assert.throws(() => validatePlanGraph({
    tasks: [
      task('first', { dependencies: ['second'] }),
      task('second', { dependencies: ['first'] }),
    ],
  }), /dependency cycle/)

  assert.throws(() => validatePlanGraph({
    tasks: [task('first', { dependencies: ['missing'] })],
  }), /references missing dependency/)
})

test('graph validation rejects invalid types, inputs, and missing acceptance criteria', () => {
  assert.throws(() => validatePlanGraph({ tasks: [task('bad', { type: 'unknown' })] }), /invalid task type/)
  assert.throws(() => validatePlanGraph({
    tasks: [task('bad', { requiredInputs: [{ kind: 'not-an-input', description: 'Invalid input.' }] })],
  }), /invalid input kind/)
  assert.throws(() => validatePlanGraph({ tasks: [task('bad', { acceptanceCriteria: [] })] }), /acceptanceCriteria/)
})

test('task output inputs must reference a declared dependency', () => {
  assert.throws(() => validatePlanGraph({
    tasks: [
      task('source'),
      task('consumer', {
        requiredInputs: [{ kind: 'task_output', description: 'Source result', sourceTaskId: 'source' }],
      }),
    ],
  }), /must depend on its task output source/)
})

test('tool tasks reject unregistered tools and accept registered tool outputs', () => {
  const invalidToolTask = task('run-tool', {
    type: 'tool',
    requiredCapability: 'tool_execution',
    specialistRole: 'execution',
    requiredInputs: [{ kind: 'tool_output', description: 'Tool result', toolId: 'missing-tool' }],
    toolInput: { value: 'test' },
  })
  assert.throws(() => validatePlanGraph({ tasks: [invalidToolTask] }), /nonexistent tool/)

  const unregister = registerTool({
    id: 'plan-graph-test-tool',
    description: 'A deterministic test tool.',
    inputSchema: { type: 'object' },
    permissions: ['tool:read'],
    validate: () => true,
    execute: async () => ({ ok: true }),
  })
  try {
    const graph = validatePlanGraph({
      tasks: [task('run-tool', {
        type: 'tool',
        requiredCapability: 'tool_execution',
        specialistRole: 'execution',
        requiredInputs: [{ kind: 'tool_output', description: 'Tool result', toolId: 'plan-graph-test-tool' }],
        toolInput: {},
      })],
    })
    assert.equal(graph.tasks[0].id, 'run-tool')
    assert.throws(() => validatePlanGraph({
      tasks: [task('run-tool', {
        type: 'tool',
        requiredCapability: 'tool_execution',
        specialistRole: 'execution',
        requiredInputs: [{ kind: 'tool_output', description: 'Tool result', toolId: 'plan-graph-test-tool' }],
        toolInput: {},
      })],
    }, { allowedToolIds: [] }), /unavailable to this task/)
  } finally {
    unregister()
  }

  const unregisterUnapproved = registerTool({
    id: 'plan-graph-unapproved-high-risk-tool',
    description: 'Tool without approval for a high-risk plan.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    permissions: ['tool:approved'],
    requiresApproval: false,
    validate: () => true,
    execute: async () => ({ ok: true }),
  })
  try {
    assert.throws(() => validatePlanGraph({
      tasks: [task('high-risk-tool', {
        type: 'tool',
        riskClassification: 'critical',
        requiredCapability: 'tool_execution',
        specialistRole: 'execution',
        requiredInputs: [{
          kind: 'tool_output',
          description: 'Action result',
          toolId: 'plan-graph-unapproved-high-risk-tool',
        }],
        toolInput: { value: 'x' },
      })],
    }), /must require approval/)
  } finally {
    unregisterUnapproved()
  }
})
