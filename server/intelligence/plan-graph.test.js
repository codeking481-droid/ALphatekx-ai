import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTool } from '../tools/registry.js'
import { registerLinkedInTools } from '../linkedin/tools.js'
import { parsePlanGraph, topologicalOrder, validatePlanGraph } from './plan-graph.js'

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

test('model PlanGraphs normalize malformed descriptive fields before strict validation', () => {
  const cases = [
    { value: 'draft created', expected: ['draft created'] },
    { value: undefined, expected: ['Task output prepared for review'] },
    { value: [], expected: ['Task output prepared for review'] },
    { value: null, expected: ['Task output prepared for review'] },
    { value: Array.from({ length: 12 }, (_, index) => `criterion ${index + 1}`), expected: Array.from({ length: 10 }, (_, index) => `criterion ${index + 1}`) },
    { value: [1, false, {}, null], expected: ['1', 'false'] },
  ]

  for (const { value, expected } of cases) {
    const rawTask = task('normalize-fields', {
      description: null,
      requiredInputs: null,
      dependencies: 'missing-dependency',
      expectedOutput: null,
      acceptanceCriteria: value,
      riskClassification: 'unknown',
      requiredCapability: 'unknown',
      specialistRole: 'unknown',
      maxAttempts: 99,
      completionConditions: 'draft ready',
    })
    if (value === undefined) delete rawTask.acceptanceCriteria

    const graph = parsePlanGraph(JSON.stringify({ tasks: [rawTask], ignored: true }))
    const [normalized] = graph.tasks

    assert.deepEqual(normalized.acceptanceCriteria, expected)
    assert.deepEqual(normalized.completionConditions, ['draft ready'])
    assert.equal(normalized.description, 'Complete normalize-fields.')
    assert.deepEqual(normalized.requiredInputs, [{ kind: 'user_request', description: 'The current user request.' }])
    assert.deepEqual(normalized.dependencies, [])
    assert.equal(normalized.expectedOutput, 'Complete normalize-fields. result.')
    assert.equal(normalized.riskClassification, 'medium')
    assert.equal(normalized.requiredCapability, 'reasoning')
    assert.equal(normalized.specialistRole, 'general')
    assert.equal(normalized.maxAttempts, 5)
  }
})

test('model PlanGraphs collapse dependent tasks into one LinkedIn tool task', () => {
  const unregister = registerLinkedInTools()
  try {
    const graph = parsePlanGraph(JSON.stringify({
      tasks: [
        task('task_1', {
          description: 'Draft a LinkedIn launch post.',
          requiredInputs: [],
          acceptanceCriteria: 'The post highlights Biz.',
          requiredCapability: 'content_creation',
          specialistRole: 'writer',
          completionConditions: 'Draft finalized.',
        }),
        task('task_2', {
          description: 'Publish the drafted LinkedIn post.',
          type: 'tool',
          requiredInputs: ['task_output'],
          dependencies: ['task_1'],
          acceptanceCriteria: 'The post is published after approval.',
          requiredCapability: 'tool_execution',
          specialistRole: 'execution',
          completionConditions: 'Post approved and published.',
          toolInput: { text: 'Biz is launching: an AI that never sleeps.' },
        }),
      ],
    }), { allowedToolIds: ['linkedin_post'], requiresExternalAction: true })

    assert.equal(graph.tasks.length, 1)
    assert.equal(graph.tasks[0].id, 'tool-task-1')
    assert.equal(graph.tasks[0].type, 'tool')
    assert.deepEqual(graph.tasks[0].dependencies, [])
    assert.deepEqual(graph.tasks[0].acceptanceCriteria, ['The post is published after approval.'])
    assert.equal(graph.tasks[0].requiredCapability, 'tool_execution')
    assert.equal(graph.tasks[0].specialistRole, 'execution')
    assert.deepEqual(graph.tasks[0].requiredInputs, [{
      kind: 'tool_output',
      description: 'Result from linkedin_post.',
      toolId: 'linkedin_post',
    }])
    assert.equal(graph.tasks[0].toolInput.text, 'Biz is launching: an AI that never sleeps.')
  } finally {
    unregister.forEach((remove) => remove())
  }
})

test('model PlanGraphs repair a missing tool ID and incomplete execution fields before validation', () => {
  const unregister = registerLinkedInTools()
  try {
    const graph = parsePlanGraph(JSON.stringify({
      tasks: [task('publish', {
        type: 'tool',
        requiredInputs: [{
          kind: 'tool_output',
          description: 'Publishing result.',
        }],
        dependencies: ['draft'],
        requiredCapability: 'planner',
        specialistRole: 'general',
        acceptanceCriteria: [],
        completionConditions: null,
      })],
    }), {
      allowedToolIds: ['linkedin_post'],
      requiresExternalAction: true,
      message: 'Post to LinkedIn: Biz is live.',
    })

    const [normalized] = graph.tasks
    assert.equal(normalized.id, 'tool-task-1')
    assert.equal(normalized.type, 'tool')
    assert.equal(normalized.requiredInputs[0].toolId, 'linkedin_post')
    assert.deepEqual(normalized.dependencies, [])
    assert.deepEqual(normalized.acceptanceCriteria, ['Tool result ready for approval'])
    assert.equal(normalized.requiredCapability, 'tool_execution')
    assert.equal(normalized.specialistRole, 'execution')
    assert.deepEqual(normalized.toolInput, { text: 'Biz is live.' })
  } finally {
    unregister.forEach((remove) => remove())
  }
})

test('selected connector skill can disambiguate a tool task from a short action request', () => {
  const unregister = registerLinkedInTools()
  try {
    const graph = parsePlanGraph(JSON.stringify({
      tasks: [task('publish', {
        type: 'tool',
        requiredInputs: [],
        toolInput: null,
      })],
    }), {
      allowedToolIds: ['linkedin_post', 'linkedin_reply'],
      requiresExternalAction: true,
      message: 'Make a post about Biz.',
      skill: { name: 'manage-linkedin', tools: ['linkedin_post', 'linkedin_reply'] },
    })

    assert.equal(graph.tasks[0].requiredInputs[0].toolId, 'linkedin_post')
    assert.ok(graph.tasks[0].toolInput.text)
  } finally {
    unregister.forEach((remove) => remove())
  }
})

test('external-action task collapse is connector-agnostic for Gmail', () => {
  const unregister = registerTool({
    id: 'gmail_send',
    name: 'Send Gmail Message',
    connector: 'gmail',
    description: 'Send an email after user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', minLength: 1 },
        subject: { type: 'string', minLength: 1 },
        body: { type: 'string', minLength: 1 },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    permissions: ['tool:approved'],
    requiresApproval: true,
    validate: (input) => ['to', 'subject', 'body'].every((key) =>
      typeof input?.[key] === 'string' && input[key].trim().length > 0),
    execute: async () => ({ sent: true }),
  })
  try {
    const graph = parsePlanGraph(JSON.stringify({
      tasks: [
        task('draft-email', {
          description: 'Draft the requested email.',
          acceptanceCriteria: 'Email is clear and concise.',
          toolInput: { body: 'Biz is launching: an AI that never sleeps.' },
        }),
        task('send-email', {
          description: 'Send the email after user approval.',
          type: 'tool',
          requiredInputs: [
            {
              kind: 'task_output',
              description: 'Email draft.',
              sourceTaskId: 'draft-email',
            },
            {
              kind: 'tool_output',
              description: 'Gmail delivery result.',
              toolId: 'gmail_send',
            },
          ],
          dependencies: ['draft-email'],
          acceptanceCriteria: null,
          requiredCapability: 'invalid_capability',
          specialistRole: 'invalid_role',
          toolInput: {
            to: 'daniel@example.com',
            subject: 'Biz launch',
            body: '',
          },
        }),
      ],
    }), { allowedToolIds: ['gmail_send'], requiresExternalAction: true })

    assert.equal(graph.tasks.length, 1)
    assert.equal(graph.tasks[0].id, 'tool-task-1')
    assert.deepEqual(graph.tasks[0].dependencies, [])
    assert.deepEqual(graph.tasks[0].acceptanceCriteria, ['Tool result ready for approval'])
    assert.equal(graph.tasks[0].requiredCapability, 'tool_execution')
    assert.equal(graph.tasks[0].specialistRole, 'execution')
    assert.deepEqual(graph.tasks[0].requiredInputs, [{
      kind: 'tool_output',
      description: 'Gmail delivery result.',
      toolId: 'gmail_send',
    }])
    assert.deepEqual(graph.tasks[0].toolInput, {
      to: 'daniel@example.com',
      subject: 'Biz launch',
      body: 'Biz is launching: an AI that never sleeps.',
    })
  } finally {
    unregister()
  }
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
