import test from 'node:test'
import assert from 'node:assert/strict'
import { ProviderError } from '../providers/errors.js'
import { invokeWithProviderFallback } from './error-recovery.js'

function provider(id, generate) {
  return {
    id,
    model: `${id}-model`,
    async generate() { return generate() },
  }
}

function telemetryDatabase() {
  const calls = []
  return {
    calls,
    async query(...args) {
      calls.push(args)
      return { rowCount: 1 }
    },
  }
}

test('transient provider failures fall back once and record both attempts', async () => {
  const primary = provider('primary', () => {
    throw new ProviderError('Unavailable', { provider: 'primary', retryable: true, status: 503 })
  })
  const fallback = provider('fallback', () => ({ text: 'answer', usage: { prompt_tokens: 2 } }))
  const registry = {
    list: () => [
      { id: 'primary', available: true, qualityScore: 5, latencyScore: 3, costScore: 3, capabilities: { textGeneration: true } },
      { id: 'fallback', available: true, qualityScore: 4, latencyScore: 3, costScore: 3, capabilities: { textGeneration: true } },
    ],
    get: (id) => ({ primary, fallback })[id],
  }
  const database = telemetryDatabase()
  const result = await invokeWithProviderFallback(
    registry,
    primary,
    { messages: [{ role: 'user', content: 'hello' }] },
    { userId: 'user-1', requestId: 'request-1', database },
  )

  assert.equal(result.provider.id, 'fallback')
  assert.equal(result.result.text, 'answer')
  assert.equal(database.calls.length, 3)
  assert.ok(database.calls.every(([sql, values]) => sql.includes('request_id') && values[1] === 'request-1'))
})

test('worker one falls back to worker two even when another provider ranks higher', async () => {
  const primary = provider('worker1', () => {
    throw new ProviderError('Unavailable', { provider: 'worker1', retryable: true, status: 503 })
  })
  const workerFallback = provider('worker2', () => ({ text: 'worker two answer' }))
  const otherProvider = provider('openai', () => ({ text: 'wrong fallback' }))
  const registry = {
    list: () => [
      { id: 'worker1', available: true, qualityScore: 3, latencyScore: 3, costScore: 3, capabilities: { textGeneration: true } },
      { id: 'worker2', available: true, qualityScore: 3, latencyScore: 3, costScore: 3, capabilities: { textGeneration: true } },
      { id: 'openai', available: true, qualityScore: 5, latencyScore: 1, costScore: 1, capabilities: { textGeneration: true } },
    ],
    get: (id) => ({ worker1: primary, worker2: workerFallback, openai: otherProvider })[id],
  }

  const result = await invokeWithProviderFallback(
    registry,
    primary,
    { messages: [{ role: 'user', content: 'hello' }] },
    { database: telemetryDatabase() },
  )

  assert.equal(result.provider.id, 'worker2')
  assert.equal(result.result.text, 'worker two answer')
  assert.equal(result.fallbackUsed, true)
})

test('non-transient provider failures are not retried', async () => {
  const primary = provider('primary', () => {
    throw new ProviderError('Invalid request', { provider: 'primary', retryable: false, status: 502 })
  })
  const fallback = provider('fallback', () => ({ text: 'must not run' }))
  const registry = {
    list: () => [
      { id: 'primary', available: true, qualityScore: 5, latencyScore: 3, costScore: 3, capabilities: { textGeneration: true } },
      { id: 'fallback', available: true, qualityScore: 4, latencyScore: 3, costScore: 3, capabilities: { textGeneration: true } },
    ],
    get: (id) => ({ primary, fallback })[id],
  }
  const database = telemetryDatabase()

  await assert.rejects(
    invokeWithProviderFallback(registry, primary, { messages: [] }, { database }),
    /Invalid request/,
  )
  assert.equal(database.calls.length, 1)
})

test('cancelled model requests do not start a fallback provider', async () => {
  let attempts = 0
  const primary = provider('primary', () => {
    attempts += 1
    throw new Error('must not start')
  })
  const fallback = provider('fallback', () => {
    attempts += 1
    return { text: 'must not run' }
  })
  const registry = {
    list: () => [
      { id: 'primary', available: true, capabilities: { textGeneration: true } },
      { id: 'fallback', available: true, capabilities: { textGeneration: true } },
    ],
    get: (id) => ({ primary, fallback })[id],
  }
  const controller = new AbortController()
  controller.abort(Object.assign(new Error('Task cancelled.'), { name: 'AbortError' }))

  await assert.rejects(
    invokeWithProviderFallback(
      registry,
      primary,
      { messages: [], signal: controller.signal },
    ),
    (error) => error.name === 'AbortError',
  )
  assert.equal(attempts, 0)
})
