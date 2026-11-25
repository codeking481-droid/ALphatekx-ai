import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequireUser } from './session.js'

function response() {
  return {
    statusCode: 200,
    status(value) { this.statusCode = value; return this },
    json(value) { this.body = value; return this },
  }
}

test('authorization middleware rejects missing sessions', async () => {
  const middleware = createRequireUser(async () => null)
  const res = response()
  let nextCalled = false
  await middleware({ headers: {} }, res, () => { nextCalled = true })
  assert.equal(res.statusCode, 401)
  assert.equal(nextCalled, false)
})

test('authorization middleware attaches the authenticated identity and session', async () => {
  const session = { user: { id: 'user-1' }, session: { id: 'session-1' } }
  const middleware = createRequireUser(async () => session)
  const req = { headers: {} }
  let nextCalled = false
  await middleware(req, response(), () => { nextCalled = true })
  assert.equal(req.user, session.user)
  assert.equal(req.session, session.session)
  assert.equal(nextCalled, true)
})
