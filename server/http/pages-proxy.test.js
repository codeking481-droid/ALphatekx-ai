import test from 'node:test'
import assert from 'node:assert/strict'
import { onRequest } from '../../functions/api/[[path]].js'

test('Pages API proxy forwards auth request data and preserves upstream redirects and cookies', async () => {
  const originalFetch = globalThis.fetch
  let upstreamRequest
  globalThis.fetch = async (request) => {
    upstreamRequest = request
    return new Response(null, {
      status: 302,
      headers: {
        location: 'https://accounts.google.com/oauth',
        'set-cookie': 'better-auth.state=opaque; Path=/; Secure; SameSite=Lax',
      },
    })
  }

  try {
    const request = new Request('https://alphatekx-ai.pages.dev/api/auth/sign-in/social?source=web', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        cookie: 'existing=session',
        origin: 'https://alphatekx-ai.pages.dev',
      },
      body: JSON.stringify({ provider: 'google' }),
    })
    const response = await onRequest({ request })

    assert.equal(upstreamRequest.url, 'https://129.213.161.206.sslip.io/api/auth/sign-in/social?source=web')
    assert.equal(upstreamRequest.method, 'POST')
    assert.equal(upstreamRequest.headers.get('authorization'), 'Bearer test-token')
    assert.equal(upstreamRequest.headers.get('cookie'), 'existing=session')
    assert.equal(upstreamRequest.headers.get('origin'), 'https://alphatekx-ai.pages.dev')
    assert.equal(await upstreamRequest.text(), JSON.stringify({ provider: 'google' }))
    assert.equal(upstreamRequest.redirect, 'manual')
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://accounts.google.com/oauth')
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
