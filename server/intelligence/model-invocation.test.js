import test from 'node:test'
import assert from 'node:assert/strict'
import { invokeModel } from './model-invocation.js'

test('usage persistence failure is logged without discarding a successful provider result', async () => {
  const previousError = console.error
  let logEntry
  console.error = (line) => { logEntry = JSON.parse(line) }
  try {
    const result = await invokeModel(
      { id: 'provider-a', model: 'model-a', generate: async () => ({ text: 'answer', usage: { output_tokens: 3 } }) },
      [{ role: 'user', content: 'hello' }],
      {
        requestId: 'request-1',
        database: { query: async () => { throw new Error('database unavailable') } },
      },
    )
    assert.equal(result.text, 'answer')
    assert.equal(logEntry.event, 'ai.usage.recording_failed')
    assert.equal(logEntry.requestId, 'request-1')
  } finally {
    console.error = previousError
  }
})

test('usage persistence failure does not replace the original provider error', async () => {
  const previousError = console.error
  let logEntry
  console.error = (line) => { logEntry = JSON.parse(line) }
  const providerError = new Error('upstream timed out')
  try {
    await assert.rejects(
      invokeModel(
        { id: 'provider-a', model: 'model-a', generate: async () => { throw providerError } },
        [],
        { database: { query: async () => { throw new Error('database unavailable') } } },
      ),
      (error) => error === providerError,
    )
    assert.equal(logEntry.event, 'ai.usage.recording_failed')
  } finally {
    console.error = previousError
  }
})
