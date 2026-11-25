import test from 'node:test'
import assert from 'node:assert/strict'
import { createCorsMiddleware } from './cors.js'

const allowedOrigin = 'https://alphatekx-ai.pages.dev'

function request(method = 'GET', headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  )
  return {
    method,
    get(name) {
      return normalizedHeaders[name.toLowerCase()]
    },
  }
}

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = value },
    status(value) { this.statusCode = value; return this },
    json(value) { this.body = value; return this },
    sendStatus(value) { this.statusCode = value; return this },
  }
}

test('allows credentialed requests only from the configured frontend origin', () => {
  const res = response()
  let nextCalls = 0

  createCorsMiddleware(allowedOrigin)(
    request('GET', { origin: allowedOrigin }),
    res,
    () => { nextCalls += 1 },
  )

  assert.equal(nextCalls, 1)
  assert.equal(res.headers['Access-Control-Allow-Origin'], allowedOrigin)
  assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true')
  assert.equal(res.headers.Vary, 'Origin')
})

test('answers allowed preflight requests with requested headers and methods', () => {
  const res = response()

  createCorsMiddleware(allowedOrigin)(
    request('OPTIONS', {
      origin: allowedOrigin,
      'access-control-request-headers': 'content-type,x-requested-with',
    }),
    res,
    () => assert.fail('preflight should be handled'),
  )

  assert.equal(res.statusCode, 204)
  assert.equal(res.headers['Access-Control-Allow-Methods'], 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  assert.equal(res.headers['Access-Control-Allow-Headers'], 'content-type,x-requested-with')
  assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true')
})

test('rejects requests from other origins without enabling credentialed CORS', () => {
  const res = response()
  let nextCalls = 0

  createCorsMiddleware(allowedOrigin)(
    request('POST', { origin: 'https://attacker.example' }),
    res,
    () => { nextCalls += 1 },
  )

  assert.equal(res.statusCode, 403)
  assert.deepEqual(res.body, { error: 'Request origin is not allowed.' })
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined)
  assert.equal(nextCalls, 0)
})

test('keeps requests without an Origin header available for local tools and health checks', () => {
  const res = response()
  let nextCalls = 0

  createCorsMiddleware(allowedOrigin)(request(), res, () => { nextCalls += 1 })

  assert.equal(nextCalls, 1)
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined)
})
