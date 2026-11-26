import test from 'node:test'
import assert from 'node:assert/strict'
import { invokeFallbackChain, formatFallbackTrace, freeQuotaFailureMessage } from './fallback-chain.js'
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

test('Groq 500 falls back to Workers AI and records provider use', async () => {
  const groq = mockProvider('groq', 'Groq', () => {
    throw new ProviderError('Upstream unavailable', { provider: 'groq', retryable: true, upstreamStatus: 500, status: 503 })
  })
  const workersAi = mockProvider('workers_ai', 'Cloudflare Workers AI', () => ({ text: 'Workers AI answer' }))
  const result = await invokeFallbackChain(mockRegistry([workersAi, groq]), groq, [
    { role: 'user', content: 'hello' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.provider.id, 'workers_ai')
  assert.equal(result.result.text, 'Workers AI answer')
  assert.equal(result.fallbackUsed, true)
  assert.match(formatFallbackTrace(result.fallbackTrace), /Groq failed 500/)
  assert.match(formatFallbackTrace(result.fallbackTrace), /Cloudflare Workers AI fallback/)
})

test('a same-provider retry is reported as recovery, not as a fallback', async () => {
  let calls = 0
  const groq = mockProvider('groq', 'Groq', () => {
    calls += 1
    if (calls === 1) {
      throw new ProviderError('Rate limited', {
        provider: 'groq',
        retryable: true,
        upstreamStatus: 429,
        retryAfter: '0',
        status: 503,
      })
    }
    return { text: 'Recovered answer' }
  })
  const result = await invokeFallbackChain(mockRegistry([groq]), groq, [
    { role: 'user', content: 'hello' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.fallbackUsed, false)
  assert.equal(formatFallbackTrace(result.fallbackTrace), 'Groq failed 429; Groq recovered after retry.')
})

test('a short Retry-After is respected before retrying Groq', async () => {
  let calls = 0
  let secondCallAt
  const firstCallAt = Date.now()
  const groq = mockProvider('groq', 'Groq', () => {
    calls += 1
    if (calls === 1) {
      throw new ProviderError('Rate limited', {
        provider: 'groq',
        retryable: true,
        upstreamStatus: 429,
        retryAfter: '0.03',
        status: 503,
      })
    }
    secondCallAt = Date.now()
    return { text: 'Recovered answer' }
  })
  const result = await invokeFallbackChain(mockRegistry([groq]), groq, [
    { role: 'user', content: 'hello' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.result.text, 'Recovered answer')
  assert.ok(secondCallAt - firstCallAt >= 20)
})

test('a Groq 429 without Retry-After advances instead of retrying immediately', async () => {
  const calls = []
  const groq = mockProvider('groq', 'Groq', () => {
    calls.push('groq')
    throw new ProviderError('Rate limited', {
      provider: 'groq',
      retryable: true,
      upstreamStatus: 429,
      status: 503,
    })
  })
  const workersAi = mockProvider('workers_ai', 'Cloudflare Workers AI', () => {
    calls.push('workers_ai')
    return { text: 'Workers AI answer' }
  })
  const result = await invokeFallbackChain(mockRegistry([groq, workersAi]), groq, [
    { role: 'user', content: 'hello' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.deepEqual(calls, ['groq', 'workers_ai'])
  assert.equal(result.provider.id, 'workers_ai')
})

test('unconfigured providers are identified when the chain advances past them', async () => {
  const groq = mockProvider('groq', 'Groq', () => {
    throw new ProviderError('Unauthorized', {
      provider: 'groq',
      retryable: false,
      upstreamStatus: 401,
      status: 502,
    })
  })
  const workersAi = mockProvider('workers_ai', 'Cloudflare Workers AI', () => {
    throw new Error('Unavailable providers must not be called.')
  })
  workersAi.isAvailable = false
  const openrouter = mockProvider('openrouter', 'OpenRouter', () => ({ text: 'OpenRouter answer' }))
  const result = await invokeFallbackChain(mockRegistry([groq, workersAi, openrouter]), groq, [
    { role: 'user', content: 'hello' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.provider.id, 'openrouter')
  assert.equal(result.fallbackUsed, true)
  assert.match(formatFallbackTrace(result.fallbackTrace), /Cloudflare Workers AI not configured/)
  assert.match(formatFallbackTrace(result.fallbackTrace), /tried OpenRouter fallback/)
})

test('provider quota failures skip retries and advance in the configured free-tier order', async () => {
  const calls = []
  const groq = mockProvider('groq', 'Groq', () => {
    calls.push('groq')
    throw new ProviderError('Groq unavailable', {
      provider: 'groq',
      retryable: false,
      upstreamStatus: 401,
      status: 502,
    })
  })
  const workersAi = mockProvider('workers_ai', 'Cloudflare Workers AI', () => {
    calls.push('workers_ai')
    throw new ProviderError('Workers AI unavailable', {
      provider: 'workers_ai',
      retryable: false,
      upstreamStatus: 401,
      status: 502,
    })
  })
  const openrouter = mockProvider('openrouter', 'OpenRouter', () => {
    calls.push('openrouter')
    throw new ProviderError('Insufficient credits', {
      provider: 'openrouter',
      retryable: false,
      upstreamStatus: 402,
      status: 502,
    })
  })
  const gemini = mockProvider('gemini', 'Google Gemini', () => {
    calls.push('gemini')
    throw new ProviderError('Quota exceeded', {
      provider: 'gemini',
      retryable: true,
      upstreamStatus: 429,
      status: 503,
    })
  })
  const result = await invokeFallbackChain(mockRegistry([openrouter, gemini, workersAi, groq]), groq, [
    { role: 'user', content: 'hello' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.deepEqual(calls, ['groq', 'workers_ai', 'openrouter', 'gemini'])
  assert.equal(result.provider.id, 'local-fallback')
  assert.match(formatFallbackTrace(result.fallbackTrace), /OpenRouter free quota used/)
  assert.match(formatFallbackTrace(result.fallbackTrace), /Google Gemini free quota used/)
  assert.match(formatFallbackTrace(result.fallbackTrace), /local fallback/)
  assert.doesNotMatch(formatFallbackTrace(result.fallbackTrace), /insufficient credits|add \$5/i)
  assert.equal(freeQuotaFailureMessage('openrouter', 402), 'Free quota used, tried next fallback.')
  assert.equal(freeQuotaFailureMessage('gemini', 429), 'Free quota used, tried next fallback.')
  assert.equal(freeQuotaFailureMessage('groq', 402), null)
})

test('configured AI Worker 1 is tried after Gemini and before the local template', async () => {
  const calls = []
  const failed = (id, name, status) => mockProvider(id, name, () => {
    calls.push(id)
    throw new ProviderError(`${name} unavailable`, {
      provider: id,
      retryable: false,
      upstreamStatus: status,
      status: 502,
    })
  })
  const groq = failed('groq', 'Groq', 429)
  const workersAi = failed('workers_ai', 'Cloudflare Workers AI', 401)
  const openrouter = failed('openrouter', 'OpenRouter', 429)
  const gemini = failed('gemini', 'Google Gemini', 403)
  const worker1 = mockProvider('worker1', 'AI Worker 1', () => {
    calls.push('worker1')
    return { text: 'Worker 1 generated answer' }
  })

  const result = await invokeFallbackChain(
    mockRegistry([worker1, gemini, openrouter, workersAi, groq]),
    groq,
    [{ role: 'user', content: 'Create a new motion graphic.' }],
    { database: { query: async () => ({ rowCount: 1 }) } },
  )

  assert.deepEqual(calls, ['groq', 'workers_ai', 'openrouter', 'gemini', 'worker1'])
  assert.equal(result.provider.id, 'worker1')
  assert.equal(result.result.text, 'Worker 1 generated answer')
  assert.match(formatFallbackTrace(result.fallbackTrace), /tried AI Worker 1 fallback/)
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
  const groq = mockProvider('groq', 'Groq', () => {
    throw new ProviderError('Groq unavailable', {
      provider: 'groq',
      retryable: false,
      upstreamStatus: 401,
      status: 502,
    })
  })
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
  assert.match(result.result.text, /motion graphics intro for Biz/)
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
    assert.match(graph.tasks[0].toolInput.html, /BIZ_BUILT_IN_MOTION_TEMPLATE:providers-unavailable/)
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

test('local fallback responds naturally to a greeting', async () => {
  const result = await invokeFallbackChain(mockRegistry([]), null, [
    { role: 'user', content: 'hi' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.result.text, 'Hi! What can I help you with?')
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
  assert.match(result.result.text, /motion graphics intro for Biz/)
  assert.match(formatFallbackTrace(result.fallbackTrace), /local fallback/)
})

test('invalid JSON retries once with a short-only JSON prompt, then falls back', async () => {
  let groqCalls = 0
  const groq = mockProvider('groq', 'Groq', () => {
    groqCalls += 1
    return { text: 'not json', model: 'gpt-oss-120b' }
  })
  const workersAi = mockProvider('workers_ai', 'Cloudflare Workers AI', () => ({
    text: '{"goal":"Reply helpfully"}',
    model: 'workers-ai-model',
  }))
  const result = await invokeFallbackChain(mockRegistry([workersAi, groq]), groq, [
    { role: 'user', content: 'Reply helpfully' },
  ], {
    jsonSchema: { type: 'OBJECT' },
    database: { query: async () => ({ rowCount: 1 }) },
  })

  assert.equal(groqCalls, 2)
  assert.equal(result.provider.id, 'workers_ai')
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
