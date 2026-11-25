import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTool } from '../tools/registry.js'
import { createPlanGraph } from './planner.js'

function task(id, overrides = {}) {
  return {
    id,
    description: `Complete ${id}.`,
    type: 'analysis',
    requiredInputs: [{ kind: 'user_request', description: 'The current request.' }],
    dependencies: [],
    expectedOutput: `${id} output`,
    acceptanceCriteria: [`${id} output satisfies the requested condition.`],
    riskClassification: 'low',
    requiredCapability: 'reasoning',
    specialistRole: 'general',
    maxAttempts: 2,
    completionConditions: [`${id} output is present.`],
    ...overrides,
  }
}

test('planner requests a structured graph and validates model-generated output', async () => {
  const graph = {
    tasks: [
      task('first'),
      task('second', {
        dependencies: ['first'],
        requiredInputs: [{ kind: 'task_output', description: 'First task output', sourceTaskId: 'first' }],
      }),
    ],
  }
  let invocation
  const provider = {
    id: 'planner-provider',
    model: 'planner-model',
    capabilities: { structuredOutput: true },
    async generate(value) {
      invocation = value
      return { text: JSON.stringify(graph), model: 'planner-model' }
    },
  }
  const registry = { list: () => [], get: () => null }
  const result = await createPlanGraph(registry, provider, {
    message: 'Research then analyze.',
    objective: { goal: 'Research then analyze', deliverables: ['Analysis'] },
    userId: 'user-1',
    database: { async query() { return { rowCount: 1 } } },
  })

  assert.deepEqual(result.planGraph, graph)
  assert.equal(invocation.jsonSchema.properties.tasks.type, 'ARRAY')
  assert.match(invocation.messages[0].content, /Do not make independent tasks sequential/)
  assert.match(invocation.messages[0].content, /acceptanceCriteria and completionConditions must each be JSON arrays/)
  assert.match(invocation.messages[0].content, /Return the whole graph wrapped as/)
})

test('planner repairs unsafe malformed tool fields once before validating the final graph', async () => {
  const unregister = registerTool({
    id: 'planner-repair-test-tool',
    description: 'Publish an approved post.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    permissions: ['tool:approved'],
    requiresApproval: true,
    validate: (input) => typeof input?.text === 'string' && input.text.trim().length > 0,
    execute: async () => ({ ok: true }),
  })
  try {
    const malformed = {
      tasks: [task('publish', {
        type: 'tool',
        description: 'UNTRUSTED_SENTINEL',
        requiredInputs: ['task_output'],
        requiredCapability: 'social_media_management',
        specialistRole: 'social_media_manager',
        acceptanceCriteria: 'draft created',
        completionConditions: 'ready for approval',
        toolInput: { text: '' },
      })],
    }
    const repaired = {
      tasks: [task('publish', {
        type: 'tool',
        requiredInputs: [{
          kind: 'tool_output',
          description: 'Publishing result.',
          toolId: 'planner-repair-test-tool',
        }],
        requiredCapability: 'tool_execution',
        specialistRole: 'execution',
        toolInput: { text: 'Approved post draft.' },
      })],
    }
    let calls = 0
    let repairMessages
    const provider = {
      id: 'repair-provider',
      model: 'repair-model',
      capabilities: { structuredOutput: false },
      async generate(request) {
        calls += 1
        if (calls === 2) repairMessages = request.messages
        return { text: JSON.stringify(calls === 1 ? malformed : repaired) }
      },
    }
    const result = await createPlanGraph(
      { list: () => [], get: () => null },
      provider,
      {
        message: 'Publish this post after approval.',
        objective: { goal: 'Publish a post after approval.' },
        userId: 'user-1',
        database: { async query() { return { rowCount: 1 } } },
        allowedToolIds: ['planner-repair-test-tool'],
      },
    )

    assert.equal(calls, 2)
    assert.equal(result.planGraph.tasks[0].toolInput.text, 'Approved post draft.')
    assert.doesNotMatch(repairMessages.map(({ content }) => content).join('\n'), /UNTRUSTED_SENTINEL/)
  } finally {
    unregister()
  }
})

test('planner rejects malformed JSON instead of substituting a task list', async () => {
  const provider = {
    id: 'planner-provider',
    model: 'planner-model',
    capabilities: { structuredOutput: false },
    async generate() { return { text: '{"tasks":' } },
  }
  await assert.rejects(
    createPlanGraph(
      { list: () => [], get: () => null },
      provider,
      {
        message: 'Create a plan.',
        objective: { goal: 'Create a plan' },
        userId: 'user-1',
        database: { async query() { return { rowCount: 1 } } },
      },
    ),
    /invalid PlanGraph JSON/,
  )
})
