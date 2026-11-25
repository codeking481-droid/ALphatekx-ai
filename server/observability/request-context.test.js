import test from 'node:test'
import assert from 'node:assert/strict'
import { requestContext } from './request-context.js'

test('request context creates a server request id and emits a structured completion log', () => {
  const previousLog = console.log
  let logLine
  let finish
  let responseRequestId
  console.log = (line) => { logLine = line }
  try {
    const req = { method: 'GET', path: '/api/health' }
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        if (name === 'X-Request-Id') responseRequestId = value
      },
      on(event, handler) {
        if (event === 'finish') finish = handler
      },
    }
    let nextCalled = false
    requestContext(req, res, () => { nextCalled = true })
    finish()

    assert.equal(nextCalled, true)
    assert.match(responseRequestId, /^[0-9a-f-]{36}$/i)
    assert.equal(req.requestId, responseRequestId)
    const entry = JSON.parse(logLine)
    assert.equal(entry.event, 'http.request.completed')
    assert.equal(entry.requestId, responseRequestId)
    assert.equal(entry.path, '/api/health')
  } finally {
    console.log = previousLog
  }
})
