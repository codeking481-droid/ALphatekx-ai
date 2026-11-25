import { randomUUID } from 'node:crypto'
import { executeApprovedTool } from '../tools/executor.js'
import { processChatRequest, resumeExecutionAfterApproval } from '../intelligence/orchestrator.js'
import {
  claimNextJob,
  failJob,
  heartbeatJob,
  markRunningJobCancelled,
  setJobProgress,
} from './service.js'
import { log } from '../observability/logger.js'

const LEASE_MS = 30_000
const HEARTBEAT_MS = 5_000
const MAX_JOB_DURATION_MS = 15 * 60_000

export function createJobWorker({
  database,
  registry,
  workerId = randomUUID(),
  pollIntervalMs = 1_000,
  leaseMs = LEASE_MS,
  heartbeatMs = HEARTBEAT_MS,
  maxJobDurationMs = MAX_JOB_DURATION_MS,
  claim = claimNextJob,
  heartbeat = heartbeatJob,
  updateProgress = setJobProgress,
  fail = failJob,
  cancel = markRunningJobCancelled,
  processChat = processChatRequest,
  runApprovedTool = executeApprovedTool,
  resumeApproval = resumeExecutionAfterApproval,
}) {
  let stopped = false

  async function runNext() {
    const job = await claim({ workerId, leaseMs, database })
    if (!job) return false
    const controller = new AbortController()
    let cancelRequested = false
    let leaseLost = false
    let heartbeatBusy = false
    const update = (progress) => updateProgress({ jobId: job.id, workerId, progress, database })
    const heartbeatTimer = setInterval(async () => {
      if (heartbeatBusy) return
      heartbeatBusy = true
      try {
        const lease = await heartbeat({ jobId: job.id, workerId, leaseMs, database })
        if (!lease) {
          leaseLost = true
          controller.abort(new Error('The worker lease was lost.'))
        } else if (lease.cancelRequested) {
          cancelRequested = true
          controller.abort(Object.assign(new Error('Task cancelled by the user.'), { name: 'AbortError' }))
        }
      } catch (error) {
        leaseLost = true
        log('error', 'job.heartbeat.failed', { jobId: job.id, workerId, error: { name: error.name, message: error.message } })
        controller.abort(error)
      } finally {
        heartbeatBusy = false
      }
    }, heartbeatMs)
    const timeout = setTimeout(() => {
      controller.abort(Object.assign(new Error('The task exceeded the 15 minute worker limit.'), {
        name: 'AbortError',
        code: 'JOB_TIMEOUT',
      }))
    }, maxJobDurationMs)

    try {
      const currentLease = await heartbeat({ jobId: job.id, workerId, leaseMs, database })
      if (!currentLease) {
        leaseLost = true
        throw new Error('The worker lease was lost before execution started.')
      }
      if (currentLease.cancelRequested) {
        cancelRequested = true
        throw Object.assign(new Error('Task cancelled by the user.'), { name: 'AbortError' })
      }
      const input = parseJobInput(job.input)
      if (job.approval_id) {
        const approvalResult = await runApprovedTool({
          userId: job.user_id,
          approvalId: job.approval_id,
          database,
          signal: controller.signal,
          requestId: input.request_id || job.id,
        })
        throwIfAborted(controller.signal)
        await resumeApproval({
          userId: job.user_id,
          approvalId: job.approval_id,
          approvalResult,
          registry,
          database,
          jobId: job.id,
          workerId,
          signal: controller.signal,
          onProgress: update,
        })
      } else {
        await processChat({
          userId: job.user_id,
          requestId: input.request_id || job.id,
          conversationId: input.conversation_id || null,
          projectId: input.project_id || null,
          message: input.message,
          attachments: input.attachments || [],
          database,
          registry,
          signal: controller.signal,
          jobId: job.id,
          workerId,
          onProgress: update,
        })
      }
    } catch (error) {
      if (!cancelRequested && !leaseLost) {
        try {
          const currentLease = await heartbeat({ jobId: job.id, workerId, leaseMs, database })
          if (!currentLease) leaseLost = true
          else if (currentLease.cancelRequested) cancelRequested = true
        } catch (heartbeatError) {
          leaseLost = true
          log('error', 'job.heartbeat.failed', {
            jobId: job.id,
            workerId,
            error: { name: heartbeatError.name, message: heartbeatError.message },
          })
        }
      }
      if (cancelRequested) {
        await cancel({ jobId: job.id, workerId, database })
      } else if (!leaseLost) {
        await fail({ jobId: job.id, workerId, error, database })
        log('error', 'job.execution.failed', {
          jobId: job.id,
          workerId,
          error: { name: error.name || 'Error', code: error.code || null, message: error.message || 'Task failed.' },
        })
      }
    } finally {
      clearInterval(heartbeatTimer)
      clearTimeout(timeout)
    }
    return true
  }

  async function start() {
    while (!stopped) {
      if (!await runNext()) await delay(pollIntervalMs)
    }
  }

  function stop() {
    stopped = true
  }

  return { runNext, start, stop, workerId }
}

function parseJobInput(input) {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (cause) {
      throw new Error('Stored job input is invalid JSON.', { cause })
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.message !== 'string' || !Array.isArray(value.attachments || [])) {
    throw new Error('Stored chat job input is invalid.')
  }
  return value
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const error = signal.reason instanceof Error ? signal.reason : new Error('The task was cancelled.')
  if (error.name !== 'AbortError') error.name = 'AbortError'
  throw error
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
