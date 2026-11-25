import test from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from './rate-limit.js'

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    statusCode: 200,
    status(value) { this.statusCode = value; return this },
    json(value) { this.body = value; return this },
  }
}

test('rate limit is applied per user and resets after the configured window', () => {
  let time = 1000
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => time })
  const first = response()
  let nextCalls = 0
  limiter({ user: { id: 'user-1' } }, first, () => { nextCalls += 1 })
  assert.equal(nextCalls, 1)

  const blocked = response()
  limiter({ user: { id: 'user-1' }, requestId: 'request-1' }, blocked, () => { nextCalls += 1 })
  assert.equal(blocked.statusCode, 429)
  assert.equal(blocked.body.requestId, 'request-1')
  assert.equal(blocked.headers['Retry-After'], '1')

  time += 1000
  limiter({ user: { id: 'user-1' } }, response(), () => { nextCalls += 1 })
  assert.equal(nextCalls, 2)
})

test('rate limit does not share quotas between users', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000 })
  for (const userId of ['user-1', 'user-2']) {
    const res = response()
    limiter({ user: { id: userId } }, res, () => {})
    assert.equal(res.statusCode, 200)
  }
})
