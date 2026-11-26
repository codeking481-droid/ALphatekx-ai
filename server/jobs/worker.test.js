import test from 'node:test'
import assert from 'node:assert/strict'
import { createJobWorker } from './worker.js'
import { recoverStaleJobs } from './service.js'

test('job worker runs chat outside the HTTP submitter and passes a durable lease', async () => {
  const calls = []
  const worker = createJobWorker({
    database: {},
    registry: {},
    workerId: 'worker-1',
    heartbeatMs: 60_000,
    maxJobDurationMs: 60_000,
    claim: async ({ workerId }) => {
      assert.equal(workerId, 'worker-1')
      return {
        id: 'job-1',
        user_id: 'user-1',
        input: {
          message: 'Search for current AI news',
          conversation_id: null,
          attachments: [],
          clarification_answers: [{ question_id: 'q1', answer_text: 'Use same text 7 times' }],
        },
      }
    },
    heartbeat: async () => ({ cancelRequested: false }),
    updateProgress: async ({ progress }) => calls.push(progress.stage),
    processChat: async (request) => {
      calls.push(request.jobId)
      assert.equal(request.workerId, 'worker-1')
      assert.equal(request.message, 'Search for current AI news')
      assert.deepEqual(request.clarificationAnswers, [{ question_id: 'q1', answer_text: 'Use same text 7 times' }])
      assert.equal(request.signal.aborted, false)
    },
  })

  assert.equal(await worker.runNext(), true)
  assert.deepEqual(calls, ['job-1'])
})

test('approval continuation executes and resumes in the worker process', async () => {
  const calls = []
  const worker = createJobWorker({
    database: {},
    registry: {},
    workerId: 'worker-2',
    heartbeatMs: 60_000,
    maxJobDurationMs: 60_000,
    claim: async () => ({
      id: 'job-2',
      user_id: 'user-1',
      approval_id: 'approval-1',
      input: { message: 'Search for current AI news', attachments: [] },
    }),
    heartbeat: async () => ({ cancelRequested: false }),
    runApprovedTool: async ({ approvalId }) => {
      calls.push(`tool:${approvalId}`)
      return { status: 'verified', result: { results: [] } }
    },
    resumeApproval: async ({ approvalId, approvalResult, jobId, workerId }) => {
      calls.push(`resume:${approvalId}:${approvalResult.status}:${jobId}:${workerId}`)
    },
  })

  assert.equal(await worker.runNext(), true)
  assert.deepEqual(calls, ['tool:approval-1', 'resume:approval-1:verified:job-2:worker-2'])
})

test('worker restart recovery requeues only expired running jobs and fails exhausted attempts', async () => {
  let recoverQuery
  const database = {
    async query(sql) {
      if (sql.includes("SET status = 'cancelled'")) return { rowCount: 0 }
      recoverQuery = sql
      return { rows: [{ id: 'job-requeued', status: 'queued' }, { id: 'job-failed', status: 'failed' }] }
    },
  }
  const recovered = await recoverStaleJobs({ database })
  assert.match(recoverQuery, /status = 'running'/)
  assert.match(recoverQuery, /lease_expires_at <= now\(\)/)
  assert.deepEqual(recovered, { cancelled: 0, requeued: 1, failed: 1 })
})
