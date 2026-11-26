import test from 'node:test'
import assert from 'node:assert/strict'
import { createCloudflareWorkersAiProvider } from './cloudflare-workers-ai.js'
import { ProviderError } from './errors.js'

test('Workers AI calls Llama first with server credentials and returns normalized text', async () => {
  const provider = createCloudflareWorkersAiProvider({
    accountId: 'account-123',
    apiToken: 'secret-token-value',
    timeoutMs: 1000,
  })
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return new Response(JSON.stringify({ success: true, result: { response: 'Workers AI answer' } }))
  }

  try {
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hello' }] })
    assert.equal(result.text, 'Workers AI answer')
    assert.equal(result.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
    assert.match(request.url, /\/ai\/run\/@cf\/meta\/llama-3\.3-70b-instruct-fp8-fast$/)
    assert.equal(request.options.headers.Authorization, 'Bearer secret-token-value')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Workers AI tries Qwen when its preferred Llama model fails', async () => {
  const provider = createCloudflareWorkersAiProvider({
    accountId: 'account-123',
    apiToken: 'secret-token-value',
    timeoutMs: 1000,
  })
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(url)
    if (requests.length === 1) return new Response(JSON.stringify({ errors: [{ message: 'Model unavailable' }] }), { status: 500 })
    return new Response(JSON.stringify({ success: true, result: { response: 'Qwen answer' } }))
  }

  try {
    const result = await provider.generate({ messages: [{ role: 'user', content: 'hello' }] })
    assert.equal(result.text, 'Qwen answer')
    assert.equal(result.model, '@cf/qwen/qwen2.5-coder-32b-instruct')
    assert.equal(requests.length, 2)
    assert.match(requests[1], /@cf\/qwen\/qwen2\.5-coder-32b-instruct$/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Workers AI sanitizes provider credentials echoed in upstream errors', async () => {
  const provider = createCloudflareWorkersAiProvider({
    accountId: 'account-123',
    apiToken: 'cloudflare-secret-token',
    timeoutMs: 1000,
    models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    errors: [{ message: 'Rejected token: cloudflare-secret-token' }],
  }), { status: 401 })

  try {
    await assert.rejects(provider.generate({ messages: [{ role: 'user', content: 'hello' }] }), (error) => {
      assert.equal(error.upstreamStatus, 401)
      assert.equal(error.message.includes('cloudflare-secret-token'), false)
      assert.match(error.message, /\[REDACTED_CLOUDFLARE_API_TOKEN\]/)
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Workers AI reports unconfigured state without exposing credential values', async () => {
  const provider = createCloudflareWorkersAiProvider({
    accountId: '',
    apiToken: '',
    timeoutMs: 1000,
  })
  assert.equal(provider.isAvailable, false)
  await assert.rejects(provider.generate({ messages: [] }), (error) =>
    error instanceof ProviderError &&
    /CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/.test(error.message) &&
    !error.message.includes('secret-token'))
})
