import test from 'node:test'
import assert from 'node:assert/strict'
import { invokeFallbackChain, formatFallbackTrace } from './fallback-chain.js'
import { ProviderError } from './errors.js'
import { parsePlanGraph } from '../intelligence/plan-graph.js'
import { getTool } from '../tools/registry.js'
import { registerMotionGraphicsTool, isSafeMotionHtml } from '../tools/motion-graphics.js'
import { registerLinkedInTools } from '../linkedin/tools.js'

function mockProvider(id, name, generate) {
  return {
    id,
    name,
    model: `${id}-model`,
    isAvailable: true,
    capabilities: { textGeneration: true, structuredOutput: true, toolCalling: false },
    generate,
  }
}

function mockRegistry(providers) {
  return {
    list: () => providers.map((provider) => ({
      id: provider.id,
      available: true,
      capabilities: provider.capabilities,
    })),
    get: (id) => providers.find((provider) => provider.id === id) || null,
  }
}

test('Workers AI 500 falls back to Groq and records provider use', async () => {
  const workersAi = mockProvider('workers_ai', 'Cloudflare Workers AI', () => {
    throw new ProviderError('Upstream unavailable', { provider: 'workers_ai', retryable: true, upstreamStatus: 500, status: 503 })
  })
  const groq = mockProvider('groq', 'Groq', () => ({ text: 'Groq answer', model: 'llama-3.3-70b-versatile' }))
  const result = await invokeFallbackChain(mockRegistry([workersAi, groq]), workersAi, [
    { role: 'user', content: 'hello' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.provider.id, 'groq')
  assert.equal(result.result.text, 'Groq answer')
  assert.equal(result.fallbackUsed, true)
  assert.match(formatFallbackTrace(result.fallbackTrace), /Cloudflare Workers AI failed 500/)
  assert.match(formatFallbackTrace(result.fallbackTrace), /Groq fallback/)
})

test('ordinary text retries do not force a JSON response', async () => {
  const requests = []
  const workersAi = mockProvider('workers_ai', 'Cloudflare Workers AI', ({ messages }) => {
    requests.push(messages)
    if (requests.length === 1) {
      throw new ProviderError('Temporary failure', {
        provider: 'workers_ai',
        retryable: true,
        upstreamStatus: 503,
        status: 503,
      })
    }
    return { text: 'Recovered answer' }
  })
  const groq = mockProvider('groq', 'Groq', () => ({ text: 'Groq answer' }))
  const result = await invokeFallbackChain(mockRegistry([workersAi, groq]), workersAi, [
    { role: 'user', content: 'Explain the next step.' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.result.text, 'Recovered answer')
  assert.match(requests[1][0].content, /answer the user request directly/)
  assert.doesNotMatch(requests[1][0].content, /ONLY valid JSON/)
})

test('Workers AI and Groq down use Local template', async () => {
  const workersAi = mockProvider('workers_ai', 'Cloudflare Workers AI', () => {
    throw new ProviderError('Unavailable', { provider: 'workers_ai', retryable: true, upstreamStatus: 500, status: 503 })
  })
  const groq = mockProvider('groq', 'Groq', () => {
    throw new ProviderError('Unavailable', { provider: 'groq', retryable: true, upstreamStatus: 429, status: 503 })
  })
  const result = await invokeFallbackChain(mockRegistry([workersAi, groq]), workersAi, [
    { role: 'user', content: 'Make a motion graphics intro for Biz' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.provider.id, 'local-fallback')
  assert.match(result.result.text, /Main AI was down/)
  assert.equal(result.fallbackUsed, true)
})

test('no provider keys configured still selects the Local template instead of failing', async () => {
  const registry = mockRegistry([])
  const result = await invokeFallbackChain(registry, null, [
    { role: 'user', content: 'Help me draft a reply' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.provider.id, 'local-fallback')
  assert.match(result.result.text, /Help me draft a reply/)
})

test('local fallback builds a structured ObjectiveSpec for animation requests', async () => {
  const result = await invokeFallbackChain(mockRegistry([]), null, [
    { role: 'system', content: 'Extract an ObjectiveSpec as one JSON object.' },
    { role: 'user', content: 'Make a motion graphics intro for Biz' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  const objective = JSON.parse(result.result.text)
  assert.equal(objective.planningRequired, true)
  assert.equal(objective.requiresExternalAction, false)
})

test('local fallback builds a motion graphics tool plan for deterministic HTML creation', async () => {
  const unregister = registerMotionGraphicsTool()
  try {
    const result = await invokeFallbackChain(mockRegistry([]), null, [
      { role: 'system', content: 'Return a valid PlanGraph. Available tool: motion_graphics_create.' },
      { role: 'user', content: 'Make a motion graphics intro for Biz' },
    ], { database: { query: async () => ({ rowCount: 1 }) } })

    const graph = parsePlanGraph(result.result.text, {
      allowedToolIds: ['motion_graphics_create'],
      requiresExternalAction: false,
      message: 'Make a motion graphics intro for Biz',
    })
    assert.equal(graph.tasks[0].requiredInputs[0].toolId, 'motion_graphics_create')
    assert.equal(isSafeMotionHtml(graph.tasks[0].toolInput.html), true)
    assert.match(graph.tasks[0].toolInput.html, /BIZ/)
    assert.match(graph.tasks[0].toolInput.html, /Chat Connect Automate/)
    assert.equal(getTool('motion_graphics_create').validate(graph.tasks[0].toolInput), true)
  } finally {
    unregister()
  }
})

test('local fallback builds a LinkedIn approval plan using the supplied draft text', async () => {
  const unregister = registerLinkedInTools()
  try {
    const message = 'Post this to LinkedIn: Our team just launched Biz.'
    const result = await invokeFallbackChain(mockRegistry([]), null, [
      { role: 'system', content: 'Return a valid PlanGraph. Available tool: linkedin_post.' },
      { role: 'user', content: message },
    ], { database: { query: async () => ({ rowCount: 1 }) } })
    const graph = parsePlanGraph(result.result.text, {
      allowedToolIds: ['linkedin_post'],
      requiresExternalAction: true,
      message,
    })

    assert.equal(graph.tasks.length, 1)
    assert.equal(graph.tasks[0].requiredInputs[0].toolId, 'linkedin_post')
    assert.equal(graph.tasks[0].toolInput.text, 'Our team just launched Biz.')
    assert.equal(getTool('linkedin_post').requiresApproval, true)
  } finally {
    unregister.forEach((remove) => remove())
  }
})

test('local fallback builds a LinkedIn draft plan for a writing request', async () => {
  const unregister = registerLinkedInTools()
  try {
    const message = 'Write a LinkedIn post about renewable energy adoption'
    const result = await invokeFallbackChain(mockRegistry([]), null, [
      { role: 'system', content: 'Return a valid PlanGraph. Available tool: linkedin_post.' },
      { role: 'user', content: message },
    ], { database: { query: async () => ({ rowCount: 1 }) } })
    const graph = parsePlanGraph(result.result.text, {
      allowedToolIds: ['linkedin_post'],
      requiresExternalAction: true,
      message,
    })

    assert.match(graph.tasks[0].toolInput.text, /renewable energy adoption/)
    assert.equal(getTool('linkedin_post').requiresApproval, true)
  } finally {
    unregister.forEach((remove) => remove())
  }
})

test('local fallback returns a LinkedIn draft instead of an unhelpful echo', async () => {
  const result = await invokeFallbackChain(mockRegistry([]), null, [
    { role: 'user', content: 'Draft a LinkedIn post about renewable energy adoption' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.match(result.result.text, /LinkedIn draft based on your request \(not posted\)/)
  assert.match(result.result.text, /renewable energy adoption/)
})

test('provider failures return a useful local fallback', async () => {
  const down = (id, name) => mockProvider(id, name, () => {
    throw new ProviderError('Unavailable', { provider: id, retryable: true, upstreamStatus: 503, status: 503 })
  })
  const workersAi = down('workers_ai', 'Cloudflare Workers AI')
  const groq = down('groq', 'Groq')
  const result = await invokeFallbackChain(mockRegistry([workersAi, groq]), workersAi, [
    { role: 'user', content: 'Make a motion graphics intro for Biz' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.provider.id, 'local-fallback')
  assert.match(result.result.text, /Main AI was down/)
  assert.match(formatFallbackTrace(result.fallbackTrace), /local fallback/)
})

test('invalid JSON retries once with a short-only JSON prompt, then falls back', async () => {
  let openrouterCalls = 0
  const workersAi = mockProvider('workers_ai', 'Cloudflare Workers AI', () => {
    return { text: 'not json', model: 'workers-ai-model' }
  })
  const groq = mockProvider('groq', 'Groq', () => {
    openrouterCalls += 1
    return ({
    text: '{"goal":"Reply helpfully"}',
    model: 'groq-model',
    })
  })
  const result = await invokeFallbackChain(mockRegistry([workersAi, groq]), workersAi, [
    { role: 'user', content: 'Reply helpfully' },
  ], {
    jsonSchema: { type: 'OBJECT' },
    database: { query: async () => ({ rowCount: 1 }) },
  })

  assert.equal(openrouterCalls, 1)
  assert.equal(result.provider.id, 'groq')
  assert.equal(JSON.parse(result.result.text).goal, 'Reply helpfully')
})

test('fallback results never expose provider secrets', async () => {
  const secret = 'gsk_test-secret'
  const workersAi = mockProvider('workers_ai', 'Cloudflare Workers AI', () => {
    throw new ProviderError(`Failed with ${secret}`, { provider: 'workers_ai', retryable: true, upstreamStatus: 500, status: 503 })
  })
  const result = await invokeFallbackChain(mockRegistry([workersAi]), workersAi, [
    { role: 'user', content: 'hello' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(formatFallbackTrace(result.fallbackTrace).includes(secret), false)
})
