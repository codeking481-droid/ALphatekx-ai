import test from 'node:test'
import assert from 'node:assert/strict'
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
