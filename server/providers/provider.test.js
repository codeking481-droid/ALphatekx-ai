import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAICompatibleProvider } from './openai-compatible.js'
import { ProviderError } from './errors.js'
import { selectProvider } from '../intelligence/provider-selector.js'
import { assertProviderContract } from './interface.js'
import { createAnthropicProvider } from './anthropic.js'
import { createProviderRegistry } from './registry.js'

const makeProvider = (options = {}) => createOpenAICompatibleProvider({
  id: 'test-provider',
  name: 'Test Provider',
  baseUrl: 'https://provider.invalid/v1',
  apiKey: 'test-only-key',
  model: 'test-model',
  timeoutMs: 1000,
  ...options,
})

test('provider adapter sends the selected model and returns normalized text', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content: 'hello' } }] }))
  }
  try {
    const result = await makeProvider().generate({ messages: [{ role: 'user', content: 'hello?' }] })
    assert.equal(result.text, 'hello')
    assert.equal(request.options.headers.Authorization, 'Bearer test-only-key')
    assert.equal(JSON.parse(request.options.body).model, 'test-model')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Groq uses its configured primary model with low reasoning effort', async () => {
  const provider = createProviderRegistry({ GROQ_API_KEY: 'gsk_test-provider-secret' }).get('groq')
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body)
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'hello' } }],
    }))
  }
  try {
    await provider.generate({ messages: [{ role: 'user', content: 'hello' }] })
    assert.equal(request.model, 'openai/gpt-oss-120b')
    assert.equal(request.reasoning_effort, 'low')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('compatible provider errors include sanitized upstream details', async () => {
  const provider = makeProvider({ id: 'groq', apiKey: 'gsk_test-provider-secret' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: 'Rejected key gsk_test-provider-secret' },
  }), { status: 401 })
  try {
    await assert.rejects(provider.generate({ messages: [] }), (error) => {
      assert.equal(error.upstreamStatus, 401)
      assert.match(error.message, /groq returned HTTP 401: Rejected key/i)
      assert.doesNotMatch(error.message, /The request could not be completed/)
      assert.equal(error.message.includes('gsk_test-provider-secret'), false)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OpenRouter uses only its configured free model and reports quota failures', async () => {
  const provider = createProviderRegistry({
    OPENROUTER_API_KEY: 'sk-or-v1-test-secret',
  }).get('openrouter')
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push(body.model)
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Free model answer' } }],
    }))
  }
  try {
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hello' }] })
    assert.deepEqual(requests, ['google/gemma-4-31b-it:free'])
    assert.equal(result.text, 'Free model answer')
  } finally {
    globalThis.fetch = originalFetch
  }

  const quotaRequests = []
  globalThis.fetch = async (_url, options) => {
    quotaRequests.push(JSON.parse(options.body).model)
    return new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 })
  }
  try {
    await assert.rejects(provider.generate({ messages: [{ role: 'user', content: 'hello' }] }), (error) => {
      assert.equal(error.upstreamStatus, 402)
      return true
    })
    assert.deepEqual(quotaRequests, ['google/gemma-4-31b-it:free'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Anthropic adapter translates common tool definitions and normalizes tool calls', async () => {
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body)
    return new Response(JSON.stringify({
      model: 'claude-test',
      content: [{ type: 'tool_use', id: 'tool-call-1', name: 'lookup', input: { query: 'status' } }],
    }))
  }
  try {
    const provider = createAnthropicProvider({ apiKey: 'test-only-key', model: 'claude-test', timeoutMs: 1000 })
    const result = await provider.generate({
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Check the status.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Read a status value.',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      }],
    })
    assert.equal(request.system, 'Be concise.')
    assert.equal(request.tools[0].input_schema.type, 'object')
    assert.deepEqual(result.toolCalls[0], {
      id: 'tool-call-1',
      name: 'lookup',
      arguments: { query: 'status' },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('unconfigured provider refuses model calls with an explicit configuration error', async () => {
  const provider = makeProvider({ apiKey: '', model: '' })
  assert.equal(provider.isAvailable, false)
  await assert.rejects(provider.generate({ messages: [] }), (error) => error instanceof ProviderError && error.status === 503)
})

test('provider selector returns deterministic local fallback when no AI is configured', () => {
  const registry = { list: () => [{ id: 'openai', available: false }], get: () => null }
  assert.equal(selectProvider(registry).id, 'local-fallback')
})

test('configured AI Worker 1 joins the fallback chain while Worker 2 stays excluded', async () => {
  const registry = createProviderRegistry({
    AI_PROVIDER_URL_1: 'https://worker-one.workers.dev',
    AI_PROVIDER_URL_2: 'https://worker-two.workers.dev',
  })
  const workers = registry.list().filter(({ id }) => id === 'worker1' || id === 'worker2')
  assert.deepEqual(workers.map(({ id, available }) => [id, available]), [
    ['worker1', true],
    ['worker2', true],
  ])
  assert.equal(selectProvider(registry, { preferred: 'worker1' }).id, 'worker1')
  assert.equal(selectProvider(registry, { preferred: 'worker2', exclude: ['worker1'] }).id, 'local-fallback')

  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return new Response(JSON.stringify({ response: 'hello from worker', model: 'worker-managed-model' }))
  }
  try {
    const result = await registry.get('worker1').generate({ messages: [{ role: 'user', content: 'hello' }] })
    assert.equal(result.text, 'hello from worker')
    assert.equal(result.model, 'worker-managed-model')
    assert.equal(request.url, 'https://worker-one.workers.dev/')
    assert.equal(request.options.headers.Authorization, undefined)
    assert.deepEqual(JSON.parse(request.options.body), { messages: [{ role: 'user', content: 'hello' }] })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('AI worker errors report the upstream status and a useful diagnostic', async () => {
  const provider = createProviderRegistry({
    AI_PROVIDER_URL_1: 'https://worker-one.workers.dev',
  }).get('worker1')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('unavailable', { status: 503 })

  try {
    await assert.rejects(provider.generate({ messages: [] }), (error) => {
      assert.equal(error.provider, 'worker1')
      assert.equal(error.upstreamStatus, 503)
      assert.equal(error.code, 'worker_request_failed')
      assert.match(error.message, /AI Worker 1 returned HTTP 503/)
      assert.match(error.message, /Check the worker logs and its upstream model service/)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('AI worker serializes an object response for structured backend prompts', async () => {
  const provider = createProviderRegistry({
    AI_PROVIDER_URL_1: 'https://worker-one.workers.dev',
  }).get('worker1')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    response: { goal: 'Reply conversationally', riskClassification: 'low' },
    model: 'worker-managed-model',
  }))

  try {
    const result = await provider.generate({ messages: [] })
    assert.deepEqual(JSON.parse(result.text), {
      goal: 'Reply conversationally',
      riskClassification: 'low',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('AI worker availability depends only on its URL', () => {
  const registry = createProviderRegistry({ AI_PROVIDER_URL_1: 'https://worker-one.workers.dev' })
  assert.equal(registry.list().find(({ id }) => id === 'worker1').available, true)
  assert.equal(registry.list().find(({ id }) => id === 'worker2').available, false)
})

test('primary chain models stay on the configured free-tier model IDs', () => {
  const registry = createProviderRegistry({
    OPENROUTER_API_KEY: 'sk-or-v1-1234567890abcd',
    OPENROUTER_MODEL: 'anthropic/claude-sonnet-4',
    GEMINI_API_KEY: 'AIzaSy1234567890abcd',
    GEMINI_MODEL: 'gemini-pro',
    CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account',
    CLOUDFLARE_API_TOKEN: 'cloudflare-secret-token',
    CLOUDFLARE_AI_MODEL: '@cf/meta/llama-3.1-70b',
    GROQ_API_KEY: 'gsk_test-secret-key',
    AI_MODEL_GROQ: 'paid-groq-model',
  })
  assert.equal(registry.get('openrouter').model, 'google/gemma-4-31b-it:free')
  assert.deepEqual(registry.get('openrouter').models, ['google/gemma-4-31b-it:free'])
  assert.equal(registry.get('gemini').model, 'gemini-2.5-flash')
  assert.equal(registry.get('workers_ai').model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  assert.deepEqual(registry.get('workers_ai').models, [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/qwen/qwen2.5-coder-32b-instruct',
  ])
  assert.equal(registry.get('groq').model, 'openai/gpt-oss-120b')
  const providers = registry.list()
  assert.equal(providers.find(({ id }) => id === 'openrouter').keySuffix, 'abcd')
  assert.equal(providers.find(({ id }) => id === 'gemini').keySuffix, 'abcd')
  assert.equal(providers.find(({ id }) => id === 'groq').keySuffix, '-key')
  assert.equal(JSON.stringify(providers).includes('sk-or-v1'), false)
  assert.equal(JSON.stringify(providers).includes('AIzaSy'), false)
})

test('provider selector respects the configured fallback order', () => {
  const primaryRegistry = createProviderRegistry({
    OPENROUTER_API_KEY: 'sk-or-v1-test-secret',
    GEMINI_API_KEY: 'AIzaSy1234567890abcd',
    CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account',
    CLOUDFLARE_API_TOKEN: 'cloudflare-secret-token',
    GROQ_API_KEY: 'gsk_test-secret-key',
  })
  assert.equal(selectProvider(primaryRegistry, { preferred: 'gemini' }).id, 'groq')

  const workersRegistry = createProviderRegistry({
    CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account',
    CLOUDFLARE_API_TOKEN: 'cloudflare-secret-token',
    OPENROUTER_API_KEY: 'sk-or-v1-test-secret',
    GEMINI_API_KEY: 'AIzaSy1234567890abcd',
  })
  assert.equal(selectProvider(workersRegistry).id, 'workers_ai')

  const openrouterRegistry = createProviderRegistry({
    OPENROUTER_API_KEY: 'sk-or-v1-test-secret',
    GEMINI_API_KEY: 'AIzaSy1234567890abcd',
  })
  assert.equal(selectProvider(openrouterRegistry).id, 'openrouter')

  const geminiRegistry = createProviderRegistry({ GEMINI_API_KEY: 'AIzaSy1234567890abcd' })
  assert.equal(selectProvider(geminiRegistry).id, 'gemini')

  const workerRegistry = createProviderRegistry({ AI_PROVIDER_URL_1: 'https://worker-one.workers.dev' })
  assert.equal(selectProvider(workerRegistry).id, 'worker1')
})

test('Workers AI and Groq are available using only their server environment configuration', () => {
  const registry = createProviderRegistry({
    CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account',
    CLOUDFLARE_API_TOKEN: 'cloudflare-secret-token',
    GROQ_API_KEY: 'gsk_test-secret-key',
  })
  assert.equal(registry.get('workers_ai').isAvailable, true)
  assert.equal(registry.get('workers_ai').model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  assert.equal(registry.get('groq').isAvailable, true)
  assert.equal(registry.get('groq').model, 'openai/gpt-oss-120b')
  const catalog = JSON.stringify(registry.list())
  assert.equal(catalog.includes('cloudflare-secret-token'), false)
  assert.equal(catalog.includes('gsk_test-secret-key'), false)
})

test('AI worker uses the exact configured URL and requires HTTPS', async () => {
  const registry = createProviderRegistry({ AI_PROVIDER_URL_1: 'https://worker-one.workers.dev/custom/route' })
  const originalFetch = globalThis.fetch
  let requestUrl
  globalThis.fetch = async (url) => {
    requestUrl = url
    return new Response(JSON.stringify({ text: 'reply' }))
  }
  try {
    const result = await registry.get('worker1').generate({ messages: [] })
    assert.equal(result.text, 'reply')
    assert.equal(requestUrl, 'https://worker-one.workers.dev/custom/route')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('provider selector requires the requested capability', () => {
  const selected = { id: 'text-only' }
  const registry = {
    list: () => [
      { id: 'vision', available: true, capabilities: { textGeneration: true, imageUnderstanding: false }, qualityScore: 5, latencyScore: 3, costScore: 3 },
      { id: 'multimodal', available: true, capabilities: { textGeneration: true, imageUnderstanding: true }, qualityScore: 4, latencyScore: 3, costScore: 3 },
    ],
    get: (id) => id === 'multimodal' ? selected : null,
  }
  assert.equal(selectProvider(registry, { capability: 'imageUnderstanding' }), selected)
})

test('provider capability declarations are explicit and cannot claim missing streaming support', () => {
  assert.throws(() => assertProviderContract({
    id: 'invalid', name: 'Invalid', isAvailable: true, generate() {}, discoverModels() {},
    capabilities: { textGeneration: true },
  }), /must explicitly declare streaming support/)
})
