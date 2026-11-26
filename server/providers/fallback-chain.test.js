import test from 'node:test'
import assert from 'node:assert/strict'
import { invokeFallbackChain, formatFallbackTrace } from './fallback-chain.js'
import { ProviderError } from './errors.js'

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

test('OpenRouter 500 falls back to Gemini and records provider use', async () => {
  const openrouter = mockProvider('openrouter', 'OpenRouter', () => {
    throw new ProviderError('Upstream unavailable', { provider: 'openrouter', retryable: true, upstreamStatus: 500, status: 503 })
  })
  const gemini = mockProvider('gemini', 'Google Gemini', () => ({ text: 'Gemini answer', model: 'gemini-model' }))
  const result = await invokeFallbackChain(mockRegistry([openrouter, gemini]), openrouter, [
    { role: 'user', content: 'hello' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.provider.id, 'gemini')
  assert.equal(result.result.text, 'Gemini answer')
  assert.equal(result.fallbackUsed, true)
  assert.match(formatFallbackTrace(result.fallbackTrace), /OpenRouter failed 500/)
  assert.match(formatFallbackTrace(result.fallbackTrace), /Gemini fallback/)
})

test('OpenRouter and Gemini down use Worker 1', async () => {
  const openrouter = mockProvider('openrouter', 'OpenRouter', () => {
    throw new ProviderError('Unavailable', { provider: 'openrouter', retryable: true, upstreamStatus: 500, status: 503 })
  })
  const gemini = mockProvider('gemini', 'Google Gemini', () => {
    throw new ProviderError('Unavailable', { provider: 'gemini', retryable: true, upstreamStatus: 429, status: 503 })
  })
  const worker = mockProvider('worker1', 'AI Worker 1', () => ({ text: 'Worker answer', model: 'qwen-model' }))
  const result = await invokeFallbackChain(mockRegistry([openrouter, gemini, worker]), openrouter, [
    { role: 'user', content: 'hello' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.provider.id, 'worker1')
  assert.equal(result.result.text, 'Worker answer')
  assert.equal(result.fallbackUsed, true)
})

test('all AI providers down return a usable local fallback', async () => {
  const down = (id, name) => mockProvider(id, name, () => {
    throw new ProviderError('Unavailable', { provider: id, retryable: true, upstreamStatus: 503, status: 503 })
  })
  const openrouter = down('openrouter', 'OpenRouter')
  const gemini = down('gemini', 'Google Gemini')
  const worker = down('worker1', 'AI Worker 1')
  const result = await invokeFallbackChain(mockRegistry([openrouter, gemini, worker]), openrouter, [
    { role: 'user', content: 'Make a motion graphics intro for Biz' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(result.provider.id, 'local-fallback')
  assert.match(result.result.text, /Main AI was down/)
  assert.match(formatFallbackTrace(result.fallbackTrace), /local fallback/)
})

test('invalid JSON retries once with a short-only JSON prompt, then falls back', async () => {
  let openrouterCalls = 0
  const openrouter = mockProvider('openrouter', 'OpenRouter', () => {
    openrouterCalls += 1
    return { text: 'not json', model: 'openrouter-model' }
  })
  const gemini = mockProvider('gemini', 'Google Gemini', () => ({
    text: '{"goal":"Reply helpfully"}',
    model: 'gemini-model',
  }))
  const result = await invokeFallbackChain(mockRegistry([openrouter, gemini]), openrouter, [
    { role: 'user', content: 'Reply helpfully' },
  ], {
    jsonSchema: { type: 'OBJECT' },
    database: { query: async () => ({ rowCount: 1 }) },
  })

  assert.equal(openrouterCalls, 2)
  assert.equal(result.provider.id, 'gemini')
  assert.equal(JSON.parse(result.result.text).goal, 'Reply helpfully')
})

test('fallback results never expose provider secrets', async () => {
  const secret = 'sk-or-v1-test-secret'
  const openrouter = mockProvider('openrouter', 'OpenRouter', () => {
    throw new ProviderError(`Failed with ${secret}`, { provider: 'openrouter', retryable: true, upstreamStatus: 500, status: 503 })
  })
  const result = await invokeFallbackChain(mockRegistry([openrouter]), openrouter, [
    { role: 'user', content: 'hello' },
  ], { database: { query: async () => ({ rowCount: 1 }) } })

  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(formatFallbackTrace(result.fallbackTrace).includes(secret), false)
})
