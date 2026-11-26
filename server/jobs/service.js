import { pool } from '../db/pool.js'

export async function submitChatJob({ userId, message, conversationId = null, projectId = null, attachments = [], clarificationAnswers = [], requestId = null, timezone = 'UTC', database = pool }) {
  const input = {
    message,
    conversation_id: conversationId,
    project_id: projectId,
    attachments,
    clarification_answers: clarificationAnswers,
    request_id: requestId,
    timezone,
  }
  const { rows } = await database.query(
    `INSERT INTO jobs (user_id, status, input)
     VALUES ($1, 'queued', $2::jsonb)
     RETURNING id, status, progress, created_at`,
    [userId, JSON.stringify(input)],
  )
  return rows[0]
}

export async function getOwnedJob({ userId, jobId, database = pool }) {
  const { rows } = await database.query(
    `SELECT id, conversation_id, status, result, progress, error, attempts,
            created_at, updated_at, started_at, completed_at
     FROM jobs WHERE id = $1 AND user_id = $2`,
    [jobId, userId],
  )
  return rows[0] || null
}

export async function claimNextJob({ workerId, leaseMs = 30_000, database = pool }) {
  const { rows } = await database.query(
    `WITH candidate AS (
       SELECT id FROM jobs
       WHERE status = 'queued'
          OR (status = 'running' AND cancel_requested_at IS NULL
              AND (lease_expires_at IS NULL OR lease_expires_at <= now()))
       ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE jobs AS job
     SET status = 'running',
         lease_owner = $1,
         lease_expires_at = now() + ($2 * interval '1 millisecond'),
         heartbeat_at = now(),
         started_at = COALESCE(job.started_at, now()),
         attempts = job.attempts + 1,
         progress = '{"stage":"starting","message":"Worker claimed the task."}'::jsonb,
         updated_at = now()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.*`,
    [workerId, leaseMs],
  )
  return rows[0] || null
}

export async function heartbeatJob({ jobId, workerId, leaseMs = 30_000, progress, database = pool }) {
  const parameters = [jobId, workerId, leaseMs]
  let progressUpdate = ''
  if (progress) {
    parameters.push(JSON.stringify(progress))
    progressUpdate = ', progress = $4::jsonb'
  }
  const { rows } = await database.query(
    `UPDATE jobs
     SET heartbeat_at = now(),
         lease_expires_at = now() + ($3 * interval '1 millisecond'),
         updated_at = now()
         ${progressUpdate}
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'
     RETURNING cancel_requested_at`,
    parameters,
  )
  return rows[0] ? { cancelRequested: Boolean(rows[0].cancel_requested_at) } : null
}

export async function setJobProgress({ jobId, workerId, progress, database = pool }) {
  await database.query(
    `UPDATE jobs SET progress = $3::jsonb, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [jobId, workerId, JSON.stringify(progress)],
  )
}

export async function failJob({ jobId, workerId, error, database = pool }) {
  const { rowCount } = await database.query(
    `UPDATE jobs
     SET status = 'failed', error = $3::jsonb,
         progress = '{"stage":"failed","message":"The task could not be completed."}'::jsonb,
         lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         completed_at = now(), updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [jobId, workerId, JSON.stringify({ message: safeErrorMessage(error) })],
  )
  return rowCount > 0
}

export async function recoverStaleJobs({ database = pool } = {}) {
  const cancelled = await database.query(
    `UPDATE jobs
     SET status = 'cancelled',
         progress = '{"stage":"cancelled","message":"Task cancelled."}'::jsonb,
         lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         completed_at = now(), updated_at = now()
     WHERE status = 'running' AND cancel_requested_at IS NOT NULL
       AND (lease_expires_at IS NULL OR lease_expires_at <= now())`,
  )
  const { rows } = await database.query(
    `UPDATE jobs
     SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
         error = CASE WHEN attempts >= 3
           THEN '{"message":"The worker stopped repeatedly before completing this task."}'::jsonb
           ELSE NULL END,
         progress = CASE WHEN attempts >= 3
           THEN '{"stage":"failed","message":"The worker stopped repeatedly before completing this task."}'::jsonb
           ELSE '{"stage":"queued","message":"Recovered after a worker restart."}'::jsonb END,
         lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         completed_at = CASE WHEN attempts >= 3 THEN now() ELSE NULL END,
         updated_at = now()
     WHERE status = 'running' AND cancel_requested_at IS NULL
       AND (lease_expires_at IS NULL OR lease_expires_at <= now())
     RETURNING id, status`,
  )
  return {
    cancelled: cancelled.rowCount,
    requeued: rows.filter((row) => row.status === 'queued').length,
    failed: rows.filter((row) => row.status === 'failed').length,
  }
}

export async function markRunningJobCancelled({ jobId, workerId, database = pool }) {
  const { rowCount } = await database.query(
    `UPDATE jobs
     SET status = 'cancelled',
         progress = '{"stage":"cancelled","message":"Task cancelled."}'::jsonb,
         lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
         completed_at = now(), updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'running' AND cancel_requested_at IS NOT NULL`,
    [jobId, workerId],
  )
  return rowCount > 0
}

export async function cancelOwnedJob({ userId, jobId, database = pool }) {
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      'SELECT id, status, agent_run_id FROM jobs WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [jobId, userId],
    )
    const job = rows[0]
    if (!job) {
      await client.query('ROLLBACK')
      return null
    }
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      await client.query('COMMIT')
      return job
    }
    if (job.status === 'running') {
      await client.query(
        `UPDATE jobs SET cancel_requested_at = now(),
           progress = '{"stage":"cancelling","message":"Cancellation requested."}'::jsonb,
           updated_at = now()
         WHERE id = $1`,
        [jobId],
      )
    } else {
      await client.query(
        `UPDATE jobs SET status = 'cancelled', cancel_requested_at = now(),
           progress = '{"stage":"cancelled","message":"Task cancelled."}'::jsonb,
           completed_at = now(), updated_at = now()
         WHERE id = $1`,
        [jobId],
      )
      if (job.agent_run_id) {
        await client.query(
          `UPDATE approval_requests SET status = 'expired', decided_at = now()
           WHERE tool_execution_id IN (SELECT id FROM tool_executions WHERE agent_run_id = $1)
             AND status = 'pending'`,
          [job.agent_run_id],
        )
        await client.query(
          `UPDATE tool_executions SET status = 'cancelled', completed_at = now()
           WHERE agent_run_id = $1 AND status IN ('pending_approval', 'queued')`,
          [job.agent_run_id],
        )
        await client.query(
          `UPDATE agent_runs SET status = 'cancelled', completed_at = now()
           WHERE id = $1 AND status IN ('queued', 'running', 'waiting_approval')`,
          [job.agent_run_id],
        )
      }
    }
    await client.query('COMMIT')
    return { ...job, status: job.status === 'running' ? 'running' : 'cancelled' }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function safeErrorMessage(error) {
  return typeof error?.message === 'string' ? error.message.slice(0, 1000) : 'Task execution failed.'
}
