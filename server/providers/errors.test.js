import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchProvider, providerError, ProviderError } from './errors.js'

test('network failures and timeouts become retryable provider errors', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw Object.assign(new Error('connection reset'), { name: 'TypeError' })
  }
  try {
    await assert.rejects(fetchProvider('provider-a', 'https://provider.invalid', {}), (error) => (
      error instanceof ProviderError &&
      error.retryable &&
      error.code === 'network_error' &&
      error.provider === 'provider-a'
    ))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('provider HTTP errors distinguish transient and non-transient failures', () => {
  const limited = providerError('provider-a', new Response('', {
    status: 429,
    headers: { 'retry-after': '5' },
  }))
  const rejected = providerError('provider-a', new Response('', { status: 400 }))

  assert.equal(limited.retryable, true)
  assert.equal(limited.retryAfter, '5')
  assert.equal(limited.upstreamStatus, 429)
  assert.equal(rejected.retryable, false)
  assert.equal(rejected.upstreamStatus, 400)
})
