import test from 'node:test'
import assert from 'node:assert/strict'
import { claimNextJob, getOwnedJob, submitChatJob } from './service.js'

test('chat submission persists the input in a queued job', async () => {
  let inserted
  const database = {
    async query(sql, params) {
      assert.match(sql, /INSERT INTO jobs/)
      inserted = JSON.parse(params[1])
      return { rows: [{ id: 'job-1', status: 'queued', progress: { stage: 'queued' }, created_at: 'now' }] }
    },
  }

  const job = await submitChatJob({
    userId: 'user-1',
    message: 'Search current weather',
    attachments: [],
    database,
  })

  assert.equal(job.id, 'job-1')
  assert.equal(inserted.message, 'Search current weather')
  assert.equal(inserted.conversation_id, null)
})

test('job claims use row locks and recover only expired leases', async () => {
  const database = {
    async query(sql, params) {
      assert.match(sql, /FOR UPDATE SKIP LOCKED/)
      assert.match(sql, /lease_expires_at <= now\(\)/)
      assert.doesNotMatch(sql, /cancel_requested_at IS NULL\s+AND\s+\(lease_expires_at[^)]*\)\s+OR/)
      assert.equal(params[0], 'worker-1')
      return { rows: [{ id: 'job-1', status: 'running', lease_owner: 'worker-1', attempts: 1 }] }
    },
  }

  const job = await claimNextJob({ workerId: 'worker-1', database })
  assert.equal(job.lease_owner, 'worker-1')
})

test('job status lookup is scoped to the owning user', async () => {
  const database = {
    async query(sql, params) {
      assert.match(sql, /WHERE id = \$1 AND user_id = \$2/)
      assert.deepEqual(params, ['job-1', 'user-1'])
      return { rows: [] }
    },
  }

  assert.equal(await getOwnedJob({ userId: 'user-1', jobId: 'job-1', database }), null)
})
