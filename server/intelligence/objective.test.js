import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateClarification } from './clarification.js'
import { OBJECTIVE_SPEC_SCHEMA, parseObjectiveSpec, understandObjective } from './objective.js'

function objective(overrides = {}) {
  return {
    goal: 'Prepare the requested answer.',
    deliverables: ['A concise answer'],
    resources: [],
    scopeConstraints: [],
    timeConstraints: [],
    instructions: [],
    successCriteria: ['Address the user request'],
    missingInformation: [],
    ambiguities: [],
    assumptions: [],
    riskClassification: 'low',
    planningRequired: false,
    requiresExternalAction: false,
    ...overrides,
  }
}

test('objective understanding requests JSON schema output when the provider supports it', async () => {
  let request
  const provider = {
    id: 'structured',
    model: 'test-model',
    capabilities: { structuredOutput: true },
    async generate(value) {
      request = value
      return { text: JSON.stringify(objective()), model: 'test-model' }
    },
  }
  const registry = {
    list: () => [],
    get: (id) => id === provider.id ? provider : null,
  }
  const database = { async query() { return { rowCount: 1 } } }

  const result = await understandObjective(registry, provider, {
    message: 'Explain the objective.',
    userId: 'user-1',
    database,
  })

  assert.deepEqual(request.jsonSchema, OBJECTIVE_SPEC_SCHEMA)
  assert.equal(result.objective.goal, 'Prepare the requested answer.')
  assert.equal(result.objective.clarificationRequired, false)
})

test('objective validation rejects missing fields, unknown fields, and malformed JSON', () => {
  assert.throws(() => parseObjectiveSpec('not JSON'), /invalid ObjectiveSpec JSON/)
  assert.throws(() => parseObjectiveSpec(JSON.stringify({ goal: 'Missing required fields' })), /missing or unsupported fields/)
  assert.throws(() => parseObjectiveSpec(JSON.stringify(objective({ inventedFact: 'not allowed' }))), /missing or unsupported fields/)
})

test('objective understanding retries malformed model JSON before parsing', async () => {
  let calls = 0
  const provider = {
    id: 'repairing',
    model: 'test-model',
    capabilities: { structuredOutput: false },
    async generate(request) {
      calls += 1
      if (calls === 1) return { text: 'I can help with many things!' }
      assert.match(request.messages.at(-1).content, /Return a fresh ObjectiveSpec/)
      return { text: JSON.stringify(objective({ goal: 'Explain available capabilities.' })) }
    },
  }
  const registry = {
    list: () => [],
    get: (id) => id === provider.id ? provider : null,
  }
  const result = await understandObjective(registry, provider, {
    message: 'What can you do?',
    userId: 'user-1',
    database: { async query() { return { rowCount: 1 } } },
  })

  assert.equal(calls, 2)
  assert.equal(result.objective.goal, 'Explain available capabilities.')
  assert.equal(result.objectiveFallback, false)
})

test('repeated malformed ObjectiveSpec output falls back to safe conversational handling', async () => {
  let calls = 0
  const provider = {
    id: 'malformed',
    model: 'test-model',
    capabilities: { structuredOutput: false },
    async generate() {
      calls += 1
      return { text: 'not JSON' }
    },
  }
  const registry = {
    list: () => [],
    get: (id) => id === provider.id ? provider : null,
  }
  const result = await understandObjective(registry, provider, {
    message: 'What can you do?',
    userId: 'user-1',
    database: { async query() { return { rowCount: 1 } } },
  })

  assert.equal(calls, 2)
  assert.equal(result.objectiveFallback, true)
  assert.equal(result.objective.planningRequired, false)
  assert.equal(result.objective.requiresExternalAction, false)
  assert.equal(result.objective.clarificationRequired, false)
})

test('repeated malformed output never plans an external action from an unparsed request', async () => {
  const provider = {
    id: 'malformed-action',
    model: 'test-model',
    capabilities: { structuredOutput: false },
    async generate() { return { text: 'not JSON' } },
  }
  const registry = {
    list: () => [],
    get: (id) => id === provider.id ? provider : null,
  }
  const result = await understandObjective(registry, provider, {
    message: 'Post to LinkedIn: Biz is live.',
    userId: 'user-1',
    database: { async query() { return { rowCount: 1 } } },
  })

  assert.equal(result.objectiveFallback, true)
  assert.equal(result.objective.planningRequired, false)
  assert.equal(result.objective.requiresExternalAction, false)
  assert.equal(result.objective.clarificationRequired, true)
  assert.match(result.objective.clarificationQuestions[0], /reliably understand/)
})

test('external actions always require planning even when the model omits it', () => {
  const parsed = parseObjectiveSpec(JSON.stringify(objective({
    requiresExternalAction: true,
    planningRequired: false,
  })))

  assert.equal(parsed.planningRequired, true)
})

test('drafting-critical missing information and conflicting requirements require clarification', () => {
  const missing = objective({
    missingInformation: [{
      item: 'Source document',
      reason: 'The request asks for a summary but no document was supplied.',
      requiredFor: 'drafting',
      clarificationQuestion: 'Please attach or paste the document.',
      safeAssumption: '',
    }],
  })
  const conflict = objective({
    ambiguities: [{
      kind: 'conflict',
      description: 'The requested word limits are incompatible.',
      clarificationQuestion: 'Which word limit should I follow?',
      blocksDrafting: false,
      blocksExecution: false,
    }],
  })

  assert.equal(parseObjectiveSpec(JSON.stringify(missing)).clarificationRequired, true)
  assert.equal(parseObjectiveSpec(JSON.stringify(conflict)).clarificationRequired, true)
})

test('execution-only details permit a labeled draft but require clarification before action', () => {
  const spec = objective({
    missingInformation: [{
      item: 'Recipient',
      reason: 'The message recipient was not identified.',
      requiredFor: 'execution',
      clarificationQuestion: 'Who should receive the message?',
      safeAssumption: 'Use a placeholder recipient in the draft.',
    }],
    riskClassification: 'high',
  })
  const decision = evaluateClarification(spec)
  const validated = parseObjectiveSpec(JSON.stringify(spec))

  assert.equal(decision.clarificationRequired, false)
  assert.equal(validated.confirmationRequiredBeforeExecution, true)
  assert.ok(validated.executionQuestions.some((question) => question.includes('Who should receive')))
  assert.ok(validated.executionQuestions.some((question) => question.includes('high-impact')))
})

test('unsafe assumptions require a question instead of silently entering a draft', () => {
  const spec = objective({
    assumptions: [{
      statement: 'Assume the launch date is next month.',
      safeForDrafting: false,
      clarificationQuestion: 'What launch date should I use?',
    }],
  })

  assert.equal(parseObjectiveSpec(JSON.stringify(spec)).clarificationRequired, true)
})
