import test from 'node:test'
import assert from 'node:assert/strict'
import { runModelReviews } from './multi-model.js'

test('multi-model reviews run only the explicitly selected providers', async () => {
  const calls = []
  const usageCalls = []
  const registry = {
    get(id) {
      return {
        id,
        isAvailable: true,
        capabilities: { textGeneration: true },
        async generate() {
          calls.push(id)
          return { text: `${id} review` }
        },
      }
    },
  }
  const results = await runModelReviews({
    registry,
    providerIds: ['one', 'two'],
    messages: [{ role: 'user', content: 'review this' }],
    mode: 'parallel',
    requestId: 'request-1',
    database: {
      async query(...args) {
        usageCalls.push(args)
        return { rowCount: 1 }
      },
    },
  })
  assert.deepEqual(new Set(calls), new Set(['one', 'two']))
  assert.equal(results.length, 2)
  assert.equal(usageCalls.length, 2)
  assert.ok(usageCalls.every(([sql, values]) => sql.includes('request_id') && values[1] === 'request-1'))
})
