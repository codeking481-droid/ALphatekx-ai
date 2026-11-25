import { getTool, getToolActionFingerprint, parseApprovalDescription, serializeApprovalDescription } from './registry.js'
import { validateJsonSchema } from './schema-validation.js'
import { completeAgentTask } from '../agents/manager.js'
import { evaluateToolResult } from '../intelligence/result-evaluator.js'
import { log } from '../observability/logger.js'
import { audit } from '../observability/audit.js'
import { pool } from '../db/pool.js'
import { hasToolPermissionGrant, insertToolPermissionGrant } from './permissions.js'

export async function executeTool({
  toolId,
  userId,
  input,
  agentRunId = null,
  database = pool,
  signal = null,
  requestId = null,
  objectiveId = null,
  planId = null,
  taskId = null,
  attempt = null,
  providerId = null,
}) {
  const tool = getTool(toolId)
  if (!tool) throw Object.assign(new Error(`Tool "${toolId}" is not registered.`), { status: 404 })
  if (!agentRunId) throw Object.assign(new Error('Tool execution must be assigned to an agent run.'), { status: 403 })
  let serializedInput
  try {
    serializedInput = JSON.stringify(input)
  } catch (cause) {
    throw Object.assign(new Error('Tool input must be JSON serializable.', { cause }), { status: 400 })
  }
  if (typeof serializedInput !== 'string') {
    throw Object.assign(new Error('Tool input must be JSON serializable.'), { status: 400 })
  }
  const executionInput = JSON.parse(serializedInput)
  assertToolInput(tool, executionInput)
  const client = await database.connect()
  let execution
  let approvalId
  let approvalRequired = tool.requiresApproval
  try {
    await client.query('BEGIN')
    const agent = await client.query(
      `SELECT r.status, d.permissions
       FROM agent_runs r JOIN agent_definitions d ON d.id = r.agent_id
       WHERE r.id = $1 AND r.user_id = $2
       FOR UPDATE OF r`,
      [agentRunId, userId],
    )
    if (!agent.rows[0]) throw Object.assign(new Error('Agent run not found.'), { status: 404 })
    if (agent.rows[0].status !== 'running') {
      throw Object.assign(new Error('Agent run is not allowed to execute tools in its current state.'), { status: 409 })
    }
    const grantedPermissions = Array.isArray(agent.rows[0].permissions) ? agent.rows[0].permissions : []
    if (!tool.permissions.every((permission) => grantedPermissions.includes(permission))) {
      throw Object.assign(new Error('Agent is not authorized to execute this tool.'), { status: 403 })
    }
    if (approvalRequired && await hasToolPermissionGrant({ userId, tool, database: client })) {
      approvalRequired = false
    }
    const duplicate = await client.query(
      `SELECT id, status FROM tool_executions
       WHERE agent_run_id = $1 AND tool_id = $2 AND input = $3::jsonb
         AND (NOT $4::boolean OR status <> 'failed' OR COALESCE((error->>'uncertain')::boolean, false))
       LIMIT 1`,
      [agentRunId, toolId, serializedInput, tool.retrySafe],
    )
    if (duplicate.rowCount) {
      throw Object.assign(new Error('This tool call has already been recorded for the agent run.'), {
        status: 409,
        executionId: duplicate.rows[0].id,
        executionStatus: duplicate.rows[0].status,
      })
    }
    const { rows } = await client.query(
      `INSERT INTO tool_executions (tool_id, user_id, agent_run_id, status, input)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [toolId, userId, agentRunId, approvalRequired ? 'pending_approval' : 'queued', serializedInput],
    )
    execution = rows[0]
    await audit({
      userId,
      event: 'tool.execution.requested',
      resourceType: 'tool_execution',
      resourceId: execution.id,
      details: {
        tool_id: tool.id,
        agent_run_id: agentRunId,
        approval_required: approvalRequired,
        input: toolAuditDetails(tool, executionInput),
      },
    }, client)
    if (approvalRequired) {
      const approval = await client.query(
        `INSERT INTO approval_requests (user_id, tool_execution_id, status, description, expires_at)
         VALUES ($1, $2, 'pending', $3, now() + interval '30 minutes') RETURNING id`,
        [userId, execution.id, serializeApprovalDescription(tool, executionInput)],
      )
      approvalId = approval.rows[0].id
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  if (approvalRequired) {
    log('info', 'tool.execution.awaiting_approval', {
      requestId, objectiveId, planId, taskId, attempt, providerId,
      userId, toolId, agentRunId, executionId: execution.id, approvalId,
    })
    return { status: 'pending_approval', executionId: execution.id, approvalId }
  }
  return runTool(tool, {
    userId, input: executionInput, executionId: execution.id, database, signal,
    requestId, objectiveId, planId, taskId, attempt, providerId,
    agentRunId,
  })
}

export async function recoverStaleExecutions({ database = pool } = {}) {
  const client = await database.connect()
  const recovered = { uncertainTools: 0, interruptedAgents: 0, uncertainAgents: 0 }
  try {
    await client.query('BEGIN')
    const staleTools = await client.query(
      `UPDATE tool_executions
       SET status = 'failed',
           error = '{"message":"Process stopped before the tool outcome was recorded.","uncertain":true,"reconciliationRequired":true}'::jsonb,
           completed_at = now()
       WHERE status = 'running' AND started_at < now() - interval '6 minutes'
       RETURNING id, user_id, agent_run_id, tool_id`,
    )
    for (const execution of staleTools.rows) {
      await client.query(
        `UPDATE agent_runs SET status = 'failed',
           error = $2::jsonb, completed_at = now()
         WHERE id = $1 AND status = 'running'`,
        [execution.agent_run_id, JSON.stringify({
          outcome: 'uncertain',
          toolExecutionId: execution.id,
          reason: 'process_interruption',
        })],
      )
      await markPersistedTaskRecovery(client, execution.agent_run_id, 'uncertain', execution.id)
      recovered.uncertainTools += 1
      await auditSafely({
        userId: execution.user_id,
        event: 'tool.execution.recovered_uncertain',
        resourceType: 'tool_execution',
        resourceId: execution.id,
        details: { tool_id: execution.tool_id, outcome: 'uncertain', reconciliation_required: true },
      }, client)
    }

    const staleAgents = await client.query(
      `SELECT r.id, r.user_id, r.task_id,
              EXISTS (SELECT 1 FROM tool_executions e
                      WHERE e.agent_run_id = r.id AND e.status = 'completed') AS has_completed_tool,
              EXISTS (SELECT 1 FROM tool_executions e
                      WHERE e.agent_run_id = r.id
                        AND COALESCE((e.error->>'uncertain')::boolean, false)) AS has_uncertain_tool
       FROM agent_runs r
       WHERE r.status = 'running' AND r.started_at < now() - interval '20 minutes'
         AND NOT EXISTS (SELECT 1 FROM approval_requests a
                         JOIN tool_executions e ON e.id = a.tool_execution_id
                         WHERE e.agent_run_id = r.id AND a.status = 'pending')
         AND NOT EXISTS (SELECT 1 FROM tool_executions e
                         WHERE e.agent_run_id = r.id AND e.status = 'running')
       FOR UPDATE OF r SKIP LOCKED`,
    )
    for (const agent of staleAgents.rows) {
      const outcome = agent.has_completed_tool || agent.has_uncertain_tool ? 'uncertain' : 'interrupted'
      await client.query(
        `UPDATE agent_runs SET status = 'failed', error = $2::jsonb, completed_at = now()
         WHERE id = $1 AND status = 'running'`,
        [agent.id, JSON.stringify({
          outcome,
          reason: 'stale_agent_run',
          reconciliationRequired: outcome === 'uncertain',
        })],
      )
      await markPersistedTaskRecovery(client, agent.id, outcome, null)
      recovered[`${outcome}Agents`] += 1
      await auditSafely({
        userId: agent.user_id,
        event: `agent.run.recovered_${outcome}`,
        resourceType: 'agent_run',
        resourceId: agent.id,
        details: { task_id: agent.task_id, outcome, reconciliation_required: outcome === 'uncertain' },
      }, client)
    }
    await client.query('COMMIT')
    return recovered
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function decideApproval({
  userId,
  approvalId,
  decision,
  database = pool,
  requestId = null,
  deferExecution = false,
  rememberForWorkspace = false,
}) {
  if (!['approved', 'denied'].includes(decision)) {
    throw Object.assign(new Error('Approval decision must be approved or denied.'), { status: 400 })
  }
  if (typeof rememberForWorkspace !== 'boolean' || (rememberForWorkspace && decision !== 'approved')) {
    throw Object.assign(new Error('Workspace permission can only be remembered for an approved action.'), { status: 400 })
  }
  const client = await database.connect()
  let approval
  let alreadyDecided = null
  try {
    await client.query('BEGIN')
    const selection = `SELECT a.id, a.tool_execution_id, a.status AS approval_status, a.description,
              e.status AS tool_status, e.result AS tool_result, e.error AS tool_error, e.tool_id, e.input,
              r.id AS agent_run_id, r.status AS agent_status, r.input AS agent_input
       FROM approval_requests a JOIN tool_executions e ON e.id = a.tool_execution_id
       JOIN agent_runs r ON r.id = e.agent_run_id AND r.user_id = a.user_id`
    const { rows } = await client.query(
      `${selection}
       WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'pending' AND a.expires_at > now()
       FOR UPDATE OF a, e, r`,
      [approvalId, userId],
    )
    approval = rows[0]
    if (!approval) {
      const prior = await client.query(
        `${selection}
         WHERE a.id = $1 AND a.user_id = $2 AND a.status IN ('approved', 'denied')
         FOR UPDATE OF a, e, r`,
        [approvalId, userId],
      )
      if (!prior.rows[0] || prior.rows[0].approval_status !== decision) {
        throw Object.assign(new Error('Approval request not found, expired, or already decided.'), { status: 404 })
      }
      alreadyDecided = prior.rows[0]
      const priorTool = getTool(alreadyDecided.tool_id)
      const priorAction = parseApprovalDescription(alreadyDecided.description)
      if (!priorTool || (alreadyDecided.description != null && (!priorAction ||
        priorAction.fingerprint !== getToolActionFingerprint(priorTool, alreadyDecided.input)))) {
        throw Object.assign(new Error('The approved action changed or its approval record is stale.'), { status: 409 })
      }
      if (rememberForWorkspace) {
        await insertToolPermissionGrant({ userId, tool: priorTool, database: client })
        await audit({
          userId,
          event: 'tool.permission.granted',
          resourceType: 'tool_definition',
          resourceId: priorTool.id,
          details: { scope: priorTool.approvalScope },
        }, client)
      }
      await client.query('COMMIT')
    } else {
    if (!['running', 'waiting_approval'].includes(approval.agent_status)) {
      throw Object.assign(new Error('The agent run is no longer active.'), { status: 409 })
    }
    const tool = getTool(approval.tool_id)
    if (!tool) throw Object.assign(new Error(`Tool "${approval.tool_id}" is no longer registered.`), { status: 409 })
    assertToolInput(tool, approval.input, 409)
    const storedAction = parseApprovalDescription(approval.description)
    if (storedAction && storedAction.fingerprint !== getToolActionFingerprint(tool, approval.input)) {
      throw Object.assign(new Error('The approved action changed or its approval record is stale.'), { status: 409 })
    }
    await client.query(
      'UPDATE approval_requests SET status = $2, decided_at = now() WHERE id = $1',
      [approvalId, decision],
    )
    await client.query(
      'UPDATE tool_executions SET status = $2 WHERE id = $1 AND status = $3',
      [approval.tool_execution_id, decision === 'approved' ? 'queued' : 'cancelled', 'pending_approval'],
    )
    if (rememberForWorkspace) {
      await insertToolPermissionGrant({ userId, tool, database: client })
      await audit({
        userId,
        event: 'tool.permission.granted',
        resourceType: 'tool_definition',
        resourceId: tool.id,
        details: { scope: tool.approvalScope },
      }, client)
    }
    await client.query('COMMIT')
    }
    if (decision === 'approved' && approval && !deferExecution) {
      const resumed = await database.query(
        `UPDATE agent_runs SET status = 'running'
         WHERE id = $1 AND status = 'waiting_approval' RETURNING id`,
        [approval.agent_run_id],
      )
      if (!resumed.rowCount) throw Object.assign(new Error('The agent run is no longer waiting for approval.'), { status: 409 })
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  if (alreadyDecided) {
    if (decision === 'denied') return { status: 'denied', executionId: alreadyDecided.tool_execution_id }
    if (alreadyDecided.tool_status !== 'completed') {
      return {
        status: deferExecution && alreadyDecided.tool_status === 'queued'
          ? 'queued'
          : alreadyDecided.tool_error?.uncertain === true ? 'uncertain' : alreadyDecided.tool_status,
        executionId: alreadyDecided.tool_execution_id,
        agentRunId: alreadyDecided.agent_run_id,
      }
    }
    const priorTool = getTool(alreadyDecided.tool_id)
    const result = parseJsonValue(alreadyDecided.tool_result)
    const evaluation = evaluateToolResult(priorTool, result)
    const evidence = {
      kind: 'tool_execution',
      toolId: priorTool.id,
      executionId: alreadyDecided.tool_execution_id,
      status: 'completed',
      verified: evaluation.accepted,
      ...(!evaluation.accepted ? { verificationFailure: evaluation.reason } : {}),
    }
    return {
      status: 'completed',
      executionId: alreadyDecided.tool_execution_id,
      result,
      verification: evaluation.accepted
        ? { method: evaluation.method, scope: 'tool_result', checks: ['registered verifier returned true'] }
        : null,
      verificationFailure: evaluation.accepted ? null : evaluation.reason,
      evidence: [evidence],
      agentRunId: alreadyDecided.agent_run_id,
    }
  }
  if (deferExecution) {
    log('info', 'tool.approval.decision_queued', {
      requestId,
      userId,
      approvalId,
      executionId: approval.tool_execution_id,
      agentRunId: approval.agent_run_id,
      toolId: approval.tool_id,
      decision,
    })
    await auditSafely({
      userId,
      event: `tool.approval.${decision}`,
      resourceType: 'tool_execution',
      resourceId: approval.tool_execution_id,
      details: {
        request_id: requestId,
        approval_id: approvalId,
        agent_run_id: approval.agent_run_id,
        tool_id: approval.tool_id,
        decision,
        remember_for_workspace: rememberForWorkspace,
        execution_deferred_to_worker: true,
      },
    }, database)
    return {
      status: decision === 'approved' ? 'queued' : 'denied',
      executionId: approval.tool_execution_id,
      agentRunId: approval.agent_run_id,
    }
  }
  if (decision === 'denied') {
    await completeAgentTask(approval.agent_run_id, {
      status: 'cancelled',
      result: {
        status: 'cancelled',
        result: null,
        evidence: [{
          kind: 'tool_execution',
          toolId: approval.tool_id,
          executionId: approval.tool_execution_id,
          status: 'cancelled',
        }],
      },
      database,
    })
    log('info', 'tool.approval.decided', {
      requestId,
      userId,
      approvalId,
      executionId: approval.tool_execution_id,
      agentRunId: approval.agent_run_id,
      toolId: approval.tool_id,
      decision: 'denied',
    })
    await auditSafely({
      userId,
      event: 'tool.approval.denied',
      resourceType: 'tool_execution',
      resourceId: approval.tool_execution_id,
      details: {
        request_id: requestId,
        approval_id: approvalId,
        agent_run_id: approval.agent_run_id,
        tool_id: approval.tool_id,
        decision: 'denied',
      },
    }, database)
    return { status: 'denied', executionId: approval.tool_execution_id }
  }
  const tool = getTool(approval.tool_id)
  const agentInput = parseJsonObject(approval.agent_input)
  const workflowContext = agentInput?.continuation || agentInput?.workflowContext || {}
  try {
    const execution = await runTool(tool, {
      userId,
      input: approval.input,
      executionId: approval.tool_execution_id,
      database,
      requestId,
      objectiveId: workflowContext.objectiveId,
      planId: workflowContext.planId,
      taskId: agentInput?.task?.id || null,
      attempt: agentInput?.attempt || null,
      providerId: workflowContext.providerId,
      agentRunId: approval.agent_run_id,
    })
    const evaluation = evaluateToolResult(tool, execution.result)
    const evidence = {
      kind: 'tool_execution',
      toolId: tool.id,
      executionId: execution.executionId,
      status: 'completed',
      verified: evaluation.accepted,
      ...(!evaluation.accepted ? { verificationFailure: evaluation.reason } : {}),
    }
    await completeAgentTask(approval.agent_run_id, {
      status: 'completed',
      result: {
        status: evaluation.accepted ? 'verified' : 'executed',
        result: execution.result,
        evidence: [evidence],
        ...(evaluation.accepted
          ? { verification: { method: evaluation.method, scope: 'tool_result', checks: ['registered verifier returned true'] } }
          : { verificationFailure: evaluation.reason }),
      },
      database,
    })
    log('info', 'tool.approval.decided', {
      requestId,
      userId,
      approvalId,
      executionId: execution.executionId,
      agentRunId: approval.agent_run_id,
      toolId: tool.id,
      decision: 'approved',
      verified: evaluation.accepted,
    })
    await auditSafely({
      userId,
      event: 'tool.approval.approved',
      resourceType: 'tool_execution',
      resourceId: execution.executionId,
      details: {
        request_id: requestId,
        approval_id: approvalId,
        agent_run_id: approval.agent_run_id,
        tool_id: tool.id,
        verified: evaluation.accepted,
      },
    }, database)
    return {
      ...execution,
      status: 'completed',
      verification: evaluation.accepted
        ? { method: evaluation.method, scope: 'tool_result', checks: ['registered verifier returned true'] }
        : null,
      verificationFailure: evaluation.accepted ? null : evaluation.reason,
      evidence: [evidence],
      agentRunId: approval.agent_run_id,
    }
  } catch (error) {
    await completeAgentTask(approval.agent_run_id, {
      status: 'failed',
      error: { message: error.message, toolId: tool.id, executionId: approval.tool_execution_id },
      database,
    })
    throw error
  }
}

export async function executeApprovedTool({ userId, approvalId, database = pool, signal = null, requestId = null }) {
  const { rows } = await database.query(
    `SELECT a.status AS approval_status, a.description,
            e.id AS execution_id, e.status AS tool_status, e.tool_id, e.input AS tool_input,
            e.result AS tool_result, e.error AS tool_error,
            r.id AS agent_run_id, r.status AS agent_status, r.input AS agent_input
     FROM approval_requests a
     JOIN tool_executions e ON e.id = a.tool_execution_id
     JOIN agent_runs r ON r.id = e.agent_run_id AND r.user_id = a.user_id
     WHERE a.id = $1 AND a.user_id = $2`,
    [approvalId, userId],
  )
  const approval = rows[0]
  if (!approval) throw Object.assign(new Error('Approval request not found.'), { status: 404 })
  if (approval.approval_status === 'denied' || approval.tool_status === 'cancelled') {
    if (approval.agent_status === 'waiting_approval') {
      await completeAgentTask(approval.agent_run_id, {
        status: 'cancelled',
        result: {
          status: 'cancelled',
          result: null,
          evidence: [{ kind: 'tool_execution', toolId: approval.tool_id, executionId: approval.execution_id, status: 'cancelled' }],
        },
        database,
      })
    }
    return { status: 'denied', executionId: approval.execution_id, agentRunId: approval.agent_run_id }
  }
  if (approval.approval_status !== 'approved') {
    throw Object.assign(new Error('The approval has not been granted.'), { status: 409 })
  }
  const tool = getTool(approval.tool_id)
  if (!tool) throw Object.assign(new Error(`Tool "${approval.tool_id}" is no longer registered.`), { status: 409 })
  assertToolInput(tool, approval.tool_input, 409)
  const storedAction = parseApprovalDescription(approval.description)
  if (storedAction && storedAction.fingerprint !== getToolActionFingerprint(tool, approval.tool_input)) {
    throw Object.assign(new Error('The approved action changed or its approval record is stale.'), { status: 409 })
  }

  if (approval.tool_status === 'completed') {
    const result = parseJsonValue(approval.tool_result)
    const evaluation = evaluateToolResult(tool, result)
    return {
      status: evaluation.accepted ? 'verified' : 'executed',
      executionId: approval.execution_id,
      result,
      verification: evaluation.accepted
        ? { method: evaluation.method, scope: 'tool_result', checks: ['registered verifier returned true'] }
        : null,
      verificationFailure: evaluation.accepted ? null : evaluation.reason,
      evidence: [{
        kind: 'tool_execution',
        toolId: tool.id,
        executionId: approval.execution_id,
        status: 'completed',
        verified: evaluation.accepted,
        ...(!evaluation.accepted ? { verificationFailure: evaluation.reason } : {}),
      }],
      agentRunId: approval.agent_run_id,
    }
  }
  if (approval.tool_status !== 'queued') {
    throw Object.assign(new Error('The approved tool execution is not ready to resume.'), { status: 409 })
  }
  if (approval.agent_status === 'waiting_approval') {
    const resumed = await database.query(
      `UPDATE agent_runs SET status = 'running'
       WHERE id = $1 AND status = 'waiting_approval' RETURNING id`,
      [approval.agent_run_id],
    )
    if (!resumed.rowCount) throw Object.assign(new Error('The agent run is no longer waiting for approval.'), { status: 409 })
  } else if (approval.agent_status !== 'running') {
    throw Object.assign(new Error('The agent run is no longer active.'), { status: 409 })
  }

  const agentInput = parseJsonObject(approval.agent_input)
  const workflowContext = agentInput?.continuation || agentInput?.workflowContext || {}
  try {
    const execution = await runTool(tool, {
      userId,
      input: approval.tool_input,
      executionId: approval.execution_id,
      database,
      signal,
      requestId,
      objectiveId: workflowContext.objectiveId,
      planId: workflowContext.planId,
      taskId: agentInput?.task?.id || null,
      attempt: agentInput?.attempt || null,
      providerId: workflowContext.providerId,
      agentRunId: approval.agent_run_id,
    })
    const evaluation = evaluateToolResult(tool, execution.result)
    const evidence = {
      kind: 'tool_execution',
      toolId: tool.id,
      executionId: execution.executionId,
      status: 'completed',
      verified: evaluation.accepted,
      ...(!evaluation.accepted ? { verificationFailure: evaluation.reason } : {}),
    }
    await completeAgentTask(approval.agent_run_id, {
      status: 'completed',
      result: {
        status: evaluation.accepted ? 'verified' : 'executed',
        result: execution.result,
        evidence: [evidence],
        ...(evaluation.accepted
          ? { verification: { method: evaluation.method, scope: 'tool_result', checks: ['registered verifier returned true'] } }
          : { verificationFailure: evaluation.reason }),
      },
      database,
    })
    return {
      ...execution,
      status: evaluation.accepted ? 'verified' : 'executed',
      verification: evaluation.accepted
        ? { method: evaluation.method, scope: 'tool_result', checks: ['registered verifier returned true'] }
        : null,
      verificationFailure: evaluation.accepted ? null : evaluation.reason,
      evidence: [evidence],
      agentRunId: approval.agent_run_id,
    }
  } catch (error) {
    await completeAgentTask(approval.agent_run_id, {
      status: 'failed',
      error: { message: error.message, toolId: tool.id, executionId: approval.execution_id },
      database,
    })
    throw error
  }
}

async function runTool(tool, {
  userId,
  input,
  executionId,
  database,
  signal = null,
  requestId = null,
  objectiveId = null,
  planId = null,
  taskId = null,
  attempt = null,
  providerId = null,
  agentRunId = null,
}) {
  const started = await database.query(
    `UPDATE tool_executions SET status = $2, started_at = now()
     WHERE id = $1 AND status = 'queued' RETURNING id`,
    [executionId, 'running'],
  )
  if (!started.rowCount) throw Object.assign(new Error('Tool execution is no longer queued.'), { status: 409 })
  const controller = new AbortController()
  log('info', 'tool.execution.started', {
    requestId, objectiveId, planId, taskId, attempt, providerId,
    userId, toolId: tool.id, executionId, agentRunId,
  })
  let timeout
  let abortHandler
  let operation
  let resultReceived = false
  try {
    if (signal?.aborted) {
      const error = new Error('Tool execution was interrupted before the action started.')
      error.name = 'AbortError'
      throw error
    }
    operation = Promise.resolve().then(() => tool.execute({
      userId,
      input,
      signal: controller.signal,
    }))
    const timeoutPromise = new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        const error = Object.assign(
          new Error(`Tool execution timed out after ${tool.timeoutMs} ms; its side-effect status is unknown.`),
          { code: 'TOOL_TIMEOUT', uncertain: true },
        )
        controller.abort(error)
        reject(error)
      }, tool.timeoutMs)
    })
    const interruptionPromise = signal
      ? new Promise((resolve, reject) => {
          abortHandler = () => {
            const error = Object.assign(
              new Error('Tool execution was interrupted; its side-effect status is unknown.'),
              { name: 'AbortError', code: 'TOOL_INTERRUPTED', uncertain: true },
            )
            controller.abort(error)
            reject(error)
          }
          signal.addEventListener('abort', abortHandler, { once: true })
          if (signal.aborted) abortHandler()
        })
      : new Promise(() => {})
    const result = await Promise.race([operation, timeoutPromise, interruptionPromise])
    resultReceived = true
    let serializedResult
    try {
      serializedResult = JSON.stringify(result)
    } catch (cause) {
      throw Object.assign(new Error('Tool returned a non-serializable result; its side-effect status is unknown.', { cause }), {
        code: 'TOOL_RESULT_INVALID',
        uncertain: true,
      })
    }
    if (typeof serializedResult !== 'string') {
      throw Object.assign(new Error('Tool did not return a JSON result; its side-effect status is unknown.'), {
        code: 'TOOL_RESULT_INVALID',
        uncertain: true,
      })
    }
    await database.query(
      'UPDATE tool_executions SET status = $2, result = $3::jsonb, completed_at = now() WHERE id = $1',
      [executionId, 'completed', serializedResult],
    )
    log('info', 'tool.execution.response_recorded', {
      requestId, objectiveId, planId, taskId, attempt, providerId,
      userId, toolId: tool.id, executionId,
    })
    return { status: 'completed', executionId, result }
  } catch (error) {
    const uncertain = error.uncertain === true || resultReceived ||
      ['TOOL_TIMEOUT', 'TOOL_INTERRUPTED'].includes(error.code)
    await database.query(
      'UPDATE tool_executions SET status = $2, error = $3::jsonb, completed_at = now() WHERE id = $1',
      [executionId, 'failed', JSON.stringify({ message: error.message, uncertain })],
    )
    log('error', 'tool.execution.failed', {
      requestId, objectiveId, planId, taskId, attempt, providerId,
      userId, toolId: tool.id, executionId, uncertain,
      error: { name: error.name || 'Error', code: error.code || null },
    })
    if (['TOOL_TIMEOUT', 'TOOL_INTERRUPTED'].includes(error.code) && operation) {
      reconcileLateToolResult(operation, { executionId, database })
    }
    const failure = new Error(error.message || 'Tool execution failed.', { cause: error })
    failure.toolExecution = { id: executionId, status: 'failed', uncertain }
    failure.retryable = tool.retrySafe && !uncertain
    throw failure
  } finally {
    clearTimeout(timeout)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

function reconcileLateToolResult(operation, { executionId, database }) {
  operation.then(
    async (result) => {
      const serialized = JSON.stringify(result)
      if (typeof serialized !== 'string') throw new Error('Late tool result is not JSON serializable.')
      const updated = await database.query(
        `UPDATE tool_executions SET status = 'completed', result = $2::jsonb, completed_at = now()
         WHERE id = $1 AND status = 'failed'`,
        [executionId, serialized],
      )
      if (!updated.rowCount) {
        log('warn', 'tool.execution.late_result_unreconciled', { executionId })
      }
    },
    async (error) => {
      await database.query(
        `UPDATE tool_executions SET error = $2::jsonb
         WHERE id = $1 AND status = 'failed'`,
        [executionId, JSON.stringify({ message: error.message || 'Late tool execution failed.' })],
      )
    },
  ).catch((error) => {
    log('error', 'tool.execution.reconciliation_failed', {
      executionId,
      error: { name: error.name || 'Error', message: error.message || 'Late tool outcome could not be reconciled.' },
    })
  })
}

function assertToolInput(tool, input, invalidStatus = 400) {
  const schemaErrors = validateJsonSchema(tool.inputSchema, input)
  if (schemaErrors.length) {
    throw Object.assign(new Error(`Tool input does not match its registered schema: ${schemaErrors.join('; ')}`), {
      status: invalidStatus,
    })
  }
  const valid = tool.validate(input)
  if (typeof valid !== 'boolean') {
    throw new TypeError(`Tool "${tool.id}" validator must return a boolean synchronously.`)
  }
  if (!valid) {
    throw Object.assign(new Error('Tool input does not match its registered schema.'), { status: invalidStatus })
  }
}

function toolAuditDetails(tool, input) {
  const details = tool.auditDetails
    ? tool.auditDetails(input)
    : { input_fields: Object.keys(input || {}).slice(0, 20) }
  let serialized
  try {
    serialized = JSON.stringify(details)
  } catch (cause) {
    throw new TypeError(`Tool "${tool.id}" audit details must be JSON serializable.`, { cause })
  }
  if (typeof serialized !== 'string' || !details || typeof details !== 'object' || Array.isArray(details)) {
    throw new TypeError(`Tool "${tool.id}" audit details must be a JSON object.`)
  }
  return JSON.parse(serialized)
}

function parseJsonObject(value) {
  const parsed = parseJsonValue(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

async function markPersistedTaskRecovery(client, agentRunId, outcome, toolExecutionId) {
  await client.query(
    `UPDATE tasks t SET status = $2,
       metadata = jsonb_set(t.metadata, '{execution}', $3::jsonb, true),
       updated_at = now()
     FROM agent_runs r
     WHERE r.id = $1 AND t.id = r.task_id`,
    [
      agentRunId,
      outcome === 'interrupted' ? 'cancelled' : 'failed',
      JSON.stringify({
        status: outcome,
        ...(toolExecutionId ? { toolExecutionId } : {}),
        reconciliationRequired: outcome === 'uncertain',
      }),
    ],
  )
}

async function auditSafely(event, database) {
  try {
    await audit(event, database)
  } catch (error) {
    log('error', 'tool.approval.audit_failed', {
      userId: event.userId,
      resourceId: event.resourceId,
      error: { name: error.name || 'Error', message: error.message || 'Approval audit could not be persisted.' },
    })
  }
}
