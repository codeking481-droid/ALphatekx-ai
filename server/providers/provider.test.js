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

test('provider selector requires an available provider instead of returning a fake response', () => {
  const registry = { list: () => [{ id: 'openai', available: false }], get: () => null }
  assert.throws(() => selectProvider(registry), /No AI provider is configured/)
})

test('configured AI workers call their URL directly without a key or model', async () => {
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
  assert.equal(selectProvider(registry, { preferred: 'worker2', exclude: ['worker1'] }).id, 'worker2')

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
