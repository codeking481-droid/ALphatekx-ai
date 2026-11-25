import { validatePlanGraph } from './plan-graph.js'

const TASK_STATES = ['proposed', 'authorized', 'executed', 'verified', 'incomplete', 'failed', 'uncertain', 'interrupted', 'awaiting_approval', 'awaiting_input', 'blocked', 'cancelled']
const MAX_PARALLEL_TASKS = 3
const ALLOWED_TRANSITIONS = {
  proposed: ['authorized', 'failed', 'awaiting_input', 'blocked', 'cancelled', 'interrupted'],
  authorized: ['executed', 'verified', 'incomplete', 'failed', 'uncertain', 'interrupted', 'awaiting_approval', 'cancelled'],
  executed: ['verified', 'incomplete', 'failed', 'uncertain', 'interrupted'],
  verified: [],
  incomplete: [],
  failed: ['authorized', 'cancelled', 'uncertain'],
  uncertain: [],
  interrupted: [],
  awaiting_approval: ['authorized', 'cancelled'],
  awaiting_input: [],
  blocked: [],
  cancelled: [],
}

export async function executePlanGraph({
  planGraph,
  dispatch,
  signal = null,
  maxParallel = MAX_PARALLEL_TASKS,
  attemptLimit = (task) => task.maxAttempts,
  initialReport = null,
  approvedTaskResult = null,
}) {
  const graph = validatePlanGraph(planGraph)
  if (typeof dispatch !== 'function') throw new TypeError('Plan execution requires a task dispatcher.')
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > MAX_PARALLEL_TASKS) {
    throw new RangeError(`maxParallel must be between 1 and ${MAX_PARALLEL_TASKS}.`)
  }

  const priorStates = new Map((initialReport?.tasks || []).map((state) => [state.taskId, state]))
  if (initialReport && (priorStates.size !== graph.tasks.length ||
    graph.tasks.some((task) => !priorStates.has(task.id)))) {
    throw new Error('Stored execution report does not match the validated PlanGraph.')
  }
  const states = new Map(graph.tasks.map((task) => {
    const prior = priorStates.get(task.id)
    if (!prior) return [task.id, {
      taskId: task.id,
      status: 'proposed',
      transitions: ['proposed'],
      attempts: 0,
      evidence: [],
      attemptFailures: [],
    }]
    if (!TASK_STATES.includes(prior.status) || !Array.isArray(prior.transitions) ||
      !Array.isArray(prior.evidence) || !Number.isInteger(prior.attempts) || prior.attempts < 0) {
      throw new Error(`Stored execution state for task "${task.id}" is invalid.`)
    }
    return [task.id, {
      ...prior,
      transitions: [...prior.transitions],
      evidence: [...prior.evidence],
      attemptFailures: Array.isArray(prior.attemptFailures) ? [...prior.attemptFailures] : [],
    }]
  }))
  const outputs = new Map()
  for (const [taskId, state] of states) {
    if (state.status === 'verified') outputs.set(taskId, state.output)
  }
  let approvalPending = false
  let inputPending = false
  if (approvedTaskResult) {
    const state = states.get(approvedTaskResult.taskId)
    if (!state || state.status !== 'awaiting_approval' ||
      !['verified', 'executed', 'cancelled'].includes(approvedTaskResult.status)) {
      throw new Error('Approved action does not match a task awaiting approval.')
    }
    state.agentRunId = approvedTaskResult.agentRunId || state.agentRunId
    state.evidence = [...state.evidence, ...(approvedTaskResult.evidence || [])]
    state.output = approvedTaskResult.output ?? null
    state.verification = approvedTaskResult.verification || null
    if (approvedTaskResult.status === 'cancelled') {
      transition(state, 'cancelled')
    } else {
      transition(state, 'authorized')
      transition(state, 'executed')
      if (approvedTaskResult.status === 'verified') {
        transition(state, 'verified')
        outputs.set(state.taskId, state.output)
      } else {
        state.verificationFailure = approvedTaskResult.verificationFailure || 'The tool result was not verified.'
      }
    }
  }

  async function runTask(task) {
    const state = states.get(task.id)
    const attemptsAllowed = attemptLimit(task)
    if (!Number.isInteger(attemptsAllowed) || attemptsAllowed < 1 || attemptsAllowed > task.maxAttempts) {
      state.error = `Task "${task.id}" has an invalid execution attempt limit.`
      transition(state, 'failed')
      return
    }
    for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
      if (signal?.aborted) {
        transition(state, 'interrupted')
        state.error = abortMessage(signal)
        return
      }
      state.attempts = attempt
      const dependencyOutputs = Object.fromEntries(task.dependencies.map((id) => [id, outputs.get(id)]))
      try {
        const result = await dispatch(task, {
          attempt,
          dependencyOutputs,
          signal,
          onAuthorized: ({ agentId, agentRunId }) => {
            transition(state, 'authorized')
            state.agentId = agentId
            state.agentRunId = agentRunId
          },
        })
        validateDispatchResult(task.id, result)
        state.evidence = result.evidence
        state.output = result.output
        state.verification = result.verification || null
        state.verificationFailure = result.verificationFailure || null
        state.agentId = result.agentId || state.agentId
        state.agentRunId = result.agentRunId || state.agentRunId
        if (result.status === 'awaiting_approval') {
          transition(state, 'awaiting_approval')
          state.approvalId = result.approvalId || null
          approvalPending = true
          return
        }
        if (result.status === 'awaiting_input') {
          transition(state, 'awaiting_input')
          state.questions = result.questions
          inputPending = true
          return
        }
        if (result.status === 'verified') transition(state, 'executed')
        transition(state, result.status)
        if (result.status === 'failed') {
          state.error = result.error || result.verificationFailure || 'Task result failed validation.'
        } else {
          delete state.error
        }
        if (state.status === 'verified') outputs.set(task.id, result.output)
        return
      } catch (error) {
        if (error?.toolExecution?.uncertain === true) {
          if (state.status !== 'uncertain') transition(state, 'uncertain')
          state.interrupted = signal?.aborted === true || error?.code === 'TOOL_INTERRUPTED'
          state.error = safeMessage(error)
          if (error?.toolExecution) state.evidence.push({ kind: 'tool_execution', ...error.toolExecution })
          return
        }
        if (signal?.aborted || error?.name === 'AbortError') {
          transition(state, 'interrupted')
          state.error = error.message || abortMessage(signal)
          return
        }
        state.attemptFailures.push({
          attempt,
          message: safeMessage(error),
          retryable: error?.retryable === true,
          ...(error?.toolExecution ? { evidence: { kind: 'tool_execution', ...error.toolExecution } } : {}),
        })
        if (error?.toolExecution) {
          state.evidence.push({ kind: 'tool_execution', ...error.toolExecution })
        }
        state.error = safeMessage(error)
        if (state.status !== 'failed') transition(state, 'failed')
        if (attempt >= attemptsAllowed || error?.retryable !== true) return
      }
    }
  }

  while (true) {
    if (signal?.aborted || approvalPending || inputPending) break
    const ready = graph.tasks.filter((task) =>
      states.get(task.id).status === 'proposed' &&
      task.dependencies.every((id) => states.get(id).status === 'verified'))
    if (!ready.length) break

    const readyModelTasks = ready.filter((task) => task.type !== 'tool')
    if (readyModelTasks.length) {
      await Promise.all(readyModelTasks.slice(0, maxParallel).map(runTask))
    } else {
      await runTask(ready[0])
    }
  }

  for (const task of graph.tasks) {
    const state = states.get(task.id)
    if (state.status !== 'proposed') continue
    if (signal?.aborted) {
      transition(state, 'interrupted')
      state.error = abortMessage(signal)
    } else {
      if (approvalPending || inputPending) continue
      transition(state, 'blocked')
      state.error = 'A required dependency did not reach verified state.'
    }
  }

  const tasks = graph.tasks.map((task) => states.get(task.id))
  const status = tasks.some((task) => task.status === 'uncertain')
    ? 'uncertain'
    : signal?.aborted || tasks.some((task) => task.status === 'interrupted')
      ? 'interrupted'
    : approvalPending
      ? 'awaiting_approval'
      : inputPending
        ? 'awaiting_input'
        : tasks.some((task) => task.status === 'failed')
        ? 'failed'
        : tasks.every((task) => task.status === 'verified')
          ? 'completed'
          : 'partial'
  return {
    status,
    complete: status === 'completed',
    tasks,
  }
}

function validateDispatchResult(taskId, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`Task "${taskId}" returned an invalid execution result.`)
  }
  if (!['verified', 'executed', 'incomplete', 'failed', 'awaiting_approval', 'awaiting_input'].includes(result.status)) {
    throw new Error(`Task "${taskId}" returned an invalid execution status.`)
  }
  if (!Array.isArray(result.evidence) || result.evidence.some((item) =>
    !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error(`Task "${taskId}" returned invalid evidence.`)
  }
  if (result.status === 'verified' &&
    (!result.verification || typeof result.verification.method !== 'string' || !result.verification.method.trim())) {
    throw new Error(`Task "${taskId}" has no verification evidence.`)
  }
  if (['awaiting_approval', 'awaiting_input'].includes(result.status) && result.output !== null) {
    throw new Error(`Task "${taskId}" cannot produce output while waiting for authorization or user input.`)
  }
  if (result.status === 'awaiting_input' &&
    (!Array.isArray(result.questions) || !result.questions.length || result.questions.some((question) => typeof question !== 'string'))) {
    throw new Error(`Task "${taskId}" must list the missing user input while awaiting input.`)
  }
  if (result.output !== null) {
    try {
      if (JSON.stringify(result.output) === undefined) throw new Error('not serializable')
    } catch (cause) {
      throw new Error(`Task "${taskId}" output is not JSON serializable.`, { cause })
    }
  }
}

function abortMessage(signal) {
  return typeof signal?.reason?.message === 'string' ? signal.reason.message : 'Execution was interrupted.'
}

function safeMessage(error) {
  return typeof error?.message === 'string' ? error.message.slice(0, 1000) : 'Task execution failed.'
}

function transition(state, next) {
  if (!TASK_STATES.includes(next) || !ALLOWED_TRANSITIONS[state.status]?.includes(next)) {
    throw new Error(`Task "${state.taskId}" cannot transition from ${state.status} to ${next}.`)
  }
  state.status = next
  state.transitions.push(next)
}

export { TASK_STATES }
