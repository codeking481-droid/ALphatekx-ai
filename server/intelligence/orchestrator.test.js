import test from 'node:test'
import assert from 'node:assert/strict'
import { ProviderError } from '../providers/errors.js'
import { registerTool } from '../tools/registry.js'
import { registerWebSearchTool } from '../tools/web-search.js'
import { registerFileTools } from '../tools/file-tools.js'
import { registerSkillCreateTool } from '../skills/skill-create.js'
import { registerMotionGraphicsTool } from '../tools/motion-graphics.js'
import { registerLinkedInTools } from '../linkedin/tools.js'
import { processChatRequest } from './orchestrator.js'

const USER_ID = 'user-1'
const CONVERSATION_ID = 'conversation-1'
const PROJECT_ID = 'project-1'

registerWebSearchTool()
registerFileTools()
registerSkillCreateTool()
registerMotionGraphicsTool()
registerLinkedInTools()

function objective(overrides = {}) {
  return {
    goal: 'Answer the current user request.',
    deliverables: ['A clear answer'],
    resources: [],
    scopeConstraints: [],
    timeConstraints: [],
    instructions: [],
    successCriteria: ['Address the requested outcome.'],
    missingInformation: [],
    ambiguities: [],
    assumptions: [],
    riskClassification: 'low',
    planningRequired: false,
    requiresExternalAction: false,
    ...overrides,
  }
}

function task(id, overrides = {}) {
  return {
    id,
    description: `Complete ${id}.`,
    type: 'analysis',
    requiredInputs: [{ kind: 'user_request', description: 'The current user request.' }],
    dependencies: [],
    expectedOutput: `${id} findings`,
    acceptanceCriteria: [`${id} findings meet the requested conditions.`],
    riskClassification: 'low',
    requiredCapability: 'reasoning',
    specialistRole: 'general',
    maxAttempts: 2,
    completionConditions: [`${id} findings are available.`],
    ...overrides,
  }
}

function businessGraph() {
  return {
    tasks: [
      task('launch-plan', {
        description: 'Prepare the phased launch plan.',
        type: 'drafting',
        requiredInputs: [
          { kind: 'task_output', description: 'Audience analysis', sourceTaskId: 'audience' },
          { kind: 'task_output', description: 'Budget analysis', sourceTaskId: 'budget' },
        ],
        dependencies: ['audience', 'budget'],
        expectedOutput: 'A phased launch plan with owners and measures.',
        acceptanceCriteria: ['Includes owners, milestones, risks, and measurable success criteria.'],
        requiredCapability: 'writing',
      }),
      task('audience', {
        description: 'Analyze the target audience.',
        expectedOutput: 'Target audience summary.',
      }),
      task('budget', {
        description: 'Analyze the launch budget.',
        type: 'calculation',
        requiredCapability: 'calculation',
        expectedOutput: 'Budget allocation and totals.',
      }),
    ],
  }
}

function createDatabase({ history = [], memories = [] } = {}) {
  const state = {
    agentRuns: [],
    agentDefinitions: new Map(),
    auditEvents: [],
    commits: 0,
    modelUsage: [],
    persistedMessages: [],
    persistedMemories: [],
    persistedTasks: [],
    toolExecutions: [],
    approvals: [],
    trace: [],
  }
  let nextRunId = 1
  let nextMessageId = 1
  let nextTaskId = 1

  async function query(sql, values = []) {
    if (sql.includes('SELECT project_id FROM conversations')) {
      return { rowCount: 1, rows: [{ project_id: PROJECT_ID }] }
    }
    if (sql.includes('FROM projects')) return { rowCount: 1, rows: [{ id: PROJECT_ID }] }
    if (sql.includes('FROM messages m')) return { rows: history.slice(-24).reverse() }
    if (sql.includes('FROM memory_records')) return { rows: memories }
    if (sql.includes('FROM user_skills')) return { rows: [] }
    if (sql.includes('INSERT INTO audit_logs')) {
      state.auditEvents.push(values)
      return { rowCount: 1, rows: [] }
    }
    if (sql.includes('INSERT INTO ai_usage_events')) {
      state.modelUsage.push(values)
      return { rowCount: 1, rows: [] }
    }
    if (sql.includes('INSERT INTO agent_definitions')) {
      state.agentDefinitions.set(values[0], JSON.parse(values[3]))
      return { rowCount: 1, rows: [] }
    }
    if (sql.includes('INSERT INTO agent_runs')) {
      const id = `agent-run-${nextRunId++}`
      state.agentRuns.push({ id, agentId: values[0], status: 'running', input: JSON.parse(values[3]) })
      state.trace.push('agent:assigned')
      return { rowCount: 1, rows: [{ id }] }
    }
    if (sql.includes("UPDATE agent_runs SET status = 'waiting_approval'")) {
      const run = state.agentRuns.find(({ id }) => id === values[0])
      if (!run || run.status !== 'running') return { rowCount: 0, rows: [] }
      run.status = 'waiting_approval'
      state.trace.push('agent:waiting_approval')
      return { rowCount: 1, rows: [{ id: run.id }] }
    }
    if (sql.includes('UPDATE agent_runs SET status')) {
      const run = state.agentRuns.find(({ id }) => id === values[0])
      if (!run || !['running', 'waiting_approval'].includes(run.status)) return { rowCount: 0, rows: [] }
      run.status = values[1]
      state.trace.push(`agent:${values[1]}`)
      return { rowCount: 1, rows: [{ id: run.id }] }
    }
    if (sql.includes('UPDATE tool_executions SET status') && sql.includes('started_at')) {
      const execution = state.toolExecutions.find(({ id }) => id === values[0])
      if (!execution || execution.status !== 'queued') return { rowCount: 0, rows: [] }
      execution.status = values[1]
      return { rowCount: 1, rows: [{ id: execution.id }] }
    }
    if (sql.includes('UPDATE tool_executions SET status') && sql.includes('result =')) {
      const execution = state.toolExecutions.find(({ id }) => id === values[0])
      if (!execution) return { rowCount: 0, rows: [] }
      execution.status = values[1]
      execution.result = values[2] ? JSON.parse(values[2]) : null
      return { rowCount: 1, rows: [] }
    }
    if (sql.includes('UPDATE tool_executions SET status') && sql.includes('error =')) {
      const execution = state.toolExecutions.find(({ id }) => id === values[0])
      if (!execution) return { rowCount: 0, rows: [] }
      execution.status = values[1]
      execution.error = values[2] ? JSON.parse(values[2]) : null
      return { rowCount: 1, rows: [] }
    }
    throw new Error(`Unexpected database query: ${sql}`)
  }

  async function connect() {
    const pending = { messages: [], memories: [], tasks: [], auditEvents: [], toolExecutions: [], approvals: [] }
    return {
      async query(sql, values = []) {
        if (sql === 'BEGIN') return { rowCount: 0, rows: [] }
        if (sql === 'ROLLBACK') {
          pending.messages.length = 0
          pending.memories.length = 0
          pending.tasks.length = 0
          pending.auditEvents.length = 0
          pending.toolExecutions.length = 0
          pending.approvals.length = 0
          return { rowCount: 0, rows: [] }
        }
        if (sql === 'COMMIT') {
          state.commits += 1
          state.persistedMessages.push(...pending.messages)
          state.persistedMemories.push(...pending.memories)
          state.persistedTasks.push(...pending.tasks)
          state.auditEvents.push(...pending.auditEvents)
          state.toolExecutions.push(...pending.toolExecutions)
          state.approvals.push(...pending.approvals)
          return { rowCount: 0, rows: [] }
        }
        if (sql.includes('SELECT id, title, message_count, project_id FROM conversations')) {
          return {
            rowCount: 1,
            rows: [{ id: CONVERSATION_ID, title: 'Existing conversation', message_count: history.length, project_id: PROJECT_ID }],
          }
        }
        if (sql.includes('SELECT id FROM memory_records')) {
          const exists = state.persistedMemories.some((memory) =>
            memory.userId === values[0] && memory.projectId === values[1] &&
            memory.kind === values[2] && memory.content.toLowerCase() === values[3].toLowerCase())
          return { rowCount: exists ? 1 : 0, rows: exists ? [{ id: 'memory-existing' }] : [] }
        }
        if (sql.includes('INSERT INTO memory_records')) {
          const memory = {
            id: `memory-${state.persistedMemories.length + pending.memories.length + 1}`,
            userId: values[0],
            kind: values[1],
            content: values[2],
            projectId: values[3],
          }
          pending.memories.push(memory)
          return { rowCount: 1, rows: [memory] }
        }
        if (sql.includes('FROM projects')) return { rowCount: 1, rows: [{ id: PROJECT_ID }] }
        if (sql.includes('FROM agent_runs r JOIN agent_definitions')) {
          const run = state.agentRuns.find(({ id }) => id === values[0])
          return run
            ? { rowCount: 1, rows: [{ status: run.status, permissions: state.agentDefinitions.get(run.agentId) || [] }] }
            : { rowCount: 0, rows: [] }
        }
        if (sql.includes("UPDATE agent_runs SET status = 'running'")) {
          const run = state.agentRuns.find(({ id }) => id === values[0])
          if (!run || run.status !== 'waiting_approval') return { rowCount: 0, rows: [] }
          run.status = 'running'
          return { rowCount: 1, rows: [{ id: run.id }] }
        }
        if (sql.includes('FROM tool_executions')) {
          const match = state.toolExecutions.find((item) =>
            item.agentRunId === values[0] && item.toolId === values[1] &&
            JSON.stringify(item.input) === values[2])
          return match ? { rowCount: 1, rows: [{ id: match.id, status: match.status }] } : { rowCount: 0, rows: [] }
        }
        if (sql.includes('INSERT INTO tool_executions')) {
          const id = `tool-execution-${state.toolExecutions.length + pending.toolExecutions.length + 1}`
          pending.toolExecutions.push({
            id,
            toolId: values[0],
            userId: values[1],
            agentRunId: values[2],
            status: values[3],
            input: JSON.parse(values[4]),
          })
          return { rowCount: 1, rows: [{ id }] }
        }
        if (sql.includes('INSERT INTO approval_requests')) {
          const id = `approval-${state.approvals.length + pending.approvals.length + 1}`
          pending.approvals.push({ id, toolExecutionId: values[1], status: 'pending', description: values[2] })
          return { rowCount: 1, rows: [{ id }] }
        }
        if (sql.includes('UPDATE approval_requests')) {
          const approval = state.approvals.find(({ id }) => id === values[0]) ||
            pending.approvals.find(({ id }) => id === values[0])
          if (!approval) return { rowCount: 0, rows: [] }
          approval.status = values[1]
          return { rowCount: 1, rows: [] }
        }
        if (sql.includes('UPDATE tool_executions SET status') && !sql.includes('started_at') && !sql.includes('result =') && !sql.includes('error =')) {
          const execution = state.toolExecutions.find(({ id }) => id === values[0]) ||
            pending.toolExecutions.find(({ id }) => id === values[0])
          if (!execution) return { rowCount: 0, rows: [] }
          execution.status = values[1]
          return { rowCount: 1, rows: [] }
        }
        if (sql.includes("INSERT INTO messages") && sql.includes("'user'")) {
          pending.messages.push({ role: 'user', content: values[2] })
          return { rowCount: 1, rows: [{ id: `message-${nextMessageId++}` }] }
        }
        if (sql.includes("INSERT INTO messages") && sql.includes("'assistant'")) {
          pending.messages.push({ role: 'assistant', content: values[2], metadata: JSON.parse(values[3]) })
          return { rowCount: 1, rows: [] }
        }
        if (sql.includes('UPDATE attachments')) return { rowCount: 1, rows: [] }
        if (sql.includes('UPDATE conversations SET last_message')) return { rowCount: 1, rows: [] }
        if (sql.includes('INSERT INTO tasks')) {
          const id = `task-${nextTaskId++}`
          pending.tasks.push({ id, values })
          return { rowCount: 1, rows: [{ id }] }
        }
        if (sql.includes('UPDATE agent_runs SET task_id')) {
          const run = state.agentRuns.find(({ id }) => id === values[0])
          if (!run) return { rowCount: 0, rows: [] }
          run.taskId = values[1]
          if (values[2]) Object.assign(run.input, JSON.parse(values[2]))
          return { rowCount: 1, rows: [{ id: run.id }] }
        }
        if (sql.includes('INSERT INTO audit_logs')) {
          pending.auditEvents.push(values)
          return { rowCount: 1, rows: [] }
        }
        throw new Error(`Unexpected transaction query: ${sql}`)
      },
      release() {},
    }
  }

  return { state, query, connect }
}

function createRegistry({ ids = ['mock-primary', 'mock-reviewer'], handlers = {}, trace = [], structuredOutput = false } = {}) {
  const calls = []
  const providers = new Map(ids.map((id) => [id, {
    id,
    model: `${id}-model`,
    capabilities: { structuredOutput },
    async generate({ messages, ...options }) {
      const system = messages.find((item) => item.role === 'system')?.content || ''
      const stage = system.startsWith('Extract an ObjectiveSpec')
        ? 'understanding'
        : system.startsWith('Create a PlanGraph')
          ? 'planning'
          : system.startsWith('Independently verify one completed specialist task')
            ? 'task_verification'
          : system.startsWith('You are the Research and Reasoning specialist')
            ? 'task_execution'
            : 'synthesis'
      const call = { id, stage, messages, options }
      calls.push(call)
      trace.push(`model:${stage}`)
      const handler = handlers[id]?.[stage]
      if (handler) return handler(call)
      if (stage === 'understanding') {
        const requestText = messages.at(-1).content
        return { text: JSON.stringify(objective({ goal: requestText.split('\n').at(-1) })) }
      }
      if (stage === 'planning') return { text: JSON.stringify(businessGraph()) }
      if (stage === 'task_execution') return { text: JSON.stringify({ output: `Verified result for ${JSON.parse(messages.at(-1).content.slice('Specialist input:\n'.length)).task.id}.` }) }
      if (stage === 'task_verification') {
        const { task: plannedTask } = JSON.parse(messages.at(-1).content)
        return {
          text: JSON.stringify({
            accepted: true,
            deliverablesPresent: true,
            dependencyOutputsValid: true,
            checkedAcceptanceCriteria: plannedTask.acceptanceCriteria,
            issues: [],
          }),
        }
      }
      return { text: 'Here is the requested response.' }
    },
  }]))

  return {
    calls,
    registry: {
      list: () => [...providers.values()].map(({ id }) => ({
        id,
        available: true,
        capabilities: { textGeneration: true, structuredOutput },
        qualityScore: 3,
        latencyScore: 3,
        costScore: 3,
      })),
      get: (id) => providers.get(id),
    },
  }
}

function toolGraph(toolId, maxAttempts = 2) {
  return {
    tasks: [task('perform-action', {
      description: 'Perform the explicitly planned action.',
      type: 'tool',
      requiredInputs: [{ kind: 'tool_output', description: 'Registered action result.', toolId }],
      requiredCapability: 'tool_execution',
      specialistRole: 'execution',
      maxAttempts,
      toolInput: { target: 'approved-target' },
    })],
  }
}

function linkedInPostGraph(text = 'Model-generated text') {
  return {
    tasks: [task('publish-linkedin-post', {
      description: 'Submit the LinkedIn post for approval.',
      type: 'tool',
      requiredInputs: [{
        kind: 'tool_output',
        description: 'LinkedIn post publishing result.',
        toolId: 'linkedin_post',
      }],
      expectedOutput: 'A pending LinkedIn approval.',
      acceptanceCriteria: ['The post is submitted for approval.'],
      riskClassification: 'medium',
      requiredCapability: 'tool_execution',
      specialistRole: 'execution',
      maxAttempts: 1,
      completionConditions: ['The approval request is created.'],
      toolInput: { text },
    })],
  }
}

function registerMockAction(id, overrides = {}) {
  return registerTool({
    id,
    description: 'Controlled mock action.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
      additionalProperties: false,
    },
    permissions: ['tool:approved'],
    validate: (input) => typeof input?.target === 'string',
    execute: async () => ({ accepted: true }),
    ...overrides,
  })
}

async function request({
  database,
  registry,
  message,
  conversationId = CONVERSATION_ID,
  projectId = PROJECT_ID,
  signal = null,
  skillResolver,
}) {
  const previousReviews = process.env.AI_REVIEW_PROVIDERS
  process.env.AI_REVIEW_PROVIDERS = 'mock-reviewer'
  try {
    return await processChatRequest({
      userId: USER_ID,
      requestId: 'request-1',
      conversationId,
      projectId,
      message,
      database,
      registry,
      signal,
      skillResolver,
    })
  } finally {
    if (previousReviews === undefined) delete process.env.AI_REVIEW_PROVIDERS
    else process.env.AI_REVIEW_PROVIDERS = previousReviews
  }
}

function allowListedToolSkill(toolId) {
  return async ({ message }) => [{
    name: 'orchestrator-test-skill',
    description: message,
    version: '1.0.0',
    body: 'Test skill body.',
    tools: [toolId],
    enabled: true,
  }]
}

test('clear requests use ObjectiveSpec and skip planning and research', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry()

  const result = await request({ database, registry, message: 'What is a database index?' })

  assert.deepEqual(calls.map(({ stage }) => stage), ['understanding', 'synthesis'])
  assert.equal(result.skill, null)
  assert.equal(database.state.persistedMessages[1].metadata.skill, null)
  assert.equal(database.state.agentRuns.length, 0)
  assert.equal(database.state.persistedTasks.length, 0)
  assert.equal(database.state.persistedMessages[1].content, result.reply)
  assert.equal(database.state.auditEvents.length, 1)
  assert.equal(database.state.commits, 1)
})

test('capability questions receive the registered tool list without planning an action', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry()

  await request({ database, registry, message: 'What can you do?' })

  assert.deepEqual(calls.map(({ stage }) => stage), ['understanding', 'synthesis'])
  const synthesis = calls.find(({ stage }) => stage === 'synthesis')
  assert.ok(synthesis.messages.some(({ content }) =>
    content.includes('Currently registered tools') &&
    content.includes('web_search') &&
    content.includes('linkedin_post')))
  assert.ok(synthesis.messages.some(({ content }) =>
    content.includes('describe only capabilities in the currently registered tools')))
})

test('a matched skill is loaded before planning and its tool allowlist and badge are preserved', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({
            goal: 'Prepare a researched SkinSnap sales plan.',
            planningRequired: true,
          })),
        }),
      },
    },
  })
  const skillResolver = async () => [{
    name: 'example-sell-skinsnap',
    description: 'Research and draft careful, personalized outreach for selling SkinSnap to UK businesses.',
    version: '1.0.0',
    body: 'Use factual research and prepare drafts only.',
    tools: ['web_search'],
    enabled: true,
  }]

  const result = await request({
    database,
    registry,
    message: 'Sell SkinSnap to UK companies.',
    skillResolver,
  })

  const planningCall = calls.find(({ stage }) => stage === 'planning')
  assert.ok(planningCall.messages.some(({ content }) => content.includes('Matched optional skill example-sell-skinsnap@1.0.0')))
  assert.match(planningCall.messages[0].content, /"id":"web_search"/)
  assert.doesNotMatch(planningCall.messages[0].content, /"id":"file_write"/)
  assert.deepEqual(result.skill, { name: 'example-sell-skinsnap', version: '1.0.0' })
  assert.deepEqual(database.state.persistedMessages[1].metadata.skill, result.skill)
  assert.ok(database.state.auditEvents.some(([userId, event]) => userId === USER_ID && event === 'skill.used'))
})

test('unmatched requests can use per-user MCP tools without needing a Skill', async () => {
  const unregister = registerTool({
    id: 'mcp_readonly_test',
    name: 'Read connected source',
    connector: 'mcp',
    description: 'Read information from the connected MCP source.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
      additionalProperties: false,
    },
    permissions: ['tool:read'],
    readOnly: true,
    requiresApproval: false,
    validate: (input) => typeof input?.query === 'string' && input.query.trim().length > 0,
    execute: async ({ input }) => ({ answer: `Result for ${input.query}` }),
    verifyResult: (result) => typeof result?.answer === 'string',
  })
  try {
    const database = createDatabase()
    const { registry, calls } = createRegistry({
      handlers: {
        'mock-primary': {
          understanding: () => ({
            text: JSON.stringify(objective({
              goal: 'Look up the requested connected-source information.',
              planningRequired: true,
            })),
          }),
          planning: () => ({
            text: JSON.stringify({
              tasks: [task('lookup', {
                type: 'tool',
                requiredInputs: [{
                  kind: 'tool_output',
                  description: 'Connected-source result.',
                  toolId: 'mcp_readonly_test',
                }],
                requiredCapability: 'tool_execution',
                specialistRole: 'execution',
                toolInput: { query: 'latest account summary' },
              })],
            }),
          }),
        },
      },
    })

    const result = await request({
      database,
      registry,
      message: 'Look up the latest account summary from my connected source.',
      skillResolver: async () => [],
    })

    const planningInstructions = calls.find(({ stage }) => stage === 'planning').messages[0].content
    assert.ok(planningInstructions.includes('"id":"mcp_readonly_test"'))
    assert.ok(planningInstructions.includes('"readOnly":true'))
    assert.ok(database.state.toolExecutions[0], JSON.stringify({
      execution: result.execution,
      agentRuns: database.state.agentRuns,
    }))
    assert.equal(database.state.toolExecutions[0].toolId, 'mcp_readonly_test')
    assert.equal(database.state.toolExecutions[0].status, 'completed')
    assert.deepEqual(database.state.toolExecutions[0].input, { query: 'latest account summary' })
    assert.equal(result.execution.complete, true)
  } finally {
    unregister()
  }
})

test('multiple deliverables create independent tasks and explicit dependent tasks', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    trace: database.state.trace,
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({
            goal: 'Prepare a phased launch plan.',
            deliverables: ['Audience analysis', 'Budget analysis', 'Launch plan'],
            planningRequired: false,
          })),
        }),
      },
    },
  })

  await request({
    database,
    registry,
    message: 'Prepare a phased launch plan with audience, budget, owners, milestones, risks, and measurable criteria.',
  })

  assert.deepEqual(calls.map(({ stage }) => stage).sort(), [
    'planning',
    'synthesis',
    'task_execution',
    'task_execution',
    'task_execution',
    'task_verification',
    'task_verification',
    'task_verification',
    'understanding',
  ].sort())
  assert.equal(database.state.trace.filter((item) => item === 'agent:assigned').length, 3)
  assert.equal(database.state.trace.filter((item) => item === 'agent:completed').length, 3)
  assert.deepEqual(database.state.persistedTasks.map(({ values }) => values[2]), [
    'Analyze the target audience.',
    'Analyze the launch budget.',
    'Prepare the phased launch plan.',
  ])
  assert.deepEqual(database.state.persistedTasks.map(({ values }) => values[5]), [[], [], ['task-1', 'task-2']])
  const combineRun = database.state.agentRuns.find(({ input }) => input.task.id === 'launch-plan')
  assert.deepEqual(Object.keys(combineRun.input.dependencyOutputs).sort(), ['audience', 'budget'])
  assert.ok(calls.filter(({ stage }) => stage === 'task_execution')
    .every(({ messages }) => messages.at(-1).content.includes('audience, budget, owners')))
  assert.match(
    calls.find(({ stage }) => stage === 'synthesis').messages.find(({ content }) => content.includes('Task execution report')).content,
    /independent_specialist_review/,
  )
  assert.ok(database.state.agentRuns.every(({ status }) => status === 'completed'))
})

test('a one-task plan is dispatched to one bounded specialist before synthesis', async () => {
  const database = createDatabase()
  const plan = { tasks: [task('single-analysis')] }
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({ goal: 'Analyze one metric.', deliverables: ['Metric analysis'], planningRequired: true })),
        }),
        planning: () => ({ text: JSON.stringify(plan) }),
        task_execution: ({ messages }) => {
          assert.match(messages[0].content, /Complete only the assigned task/)
          assert.equal(messages.some((item) => item.content.includes('Available tools:')), false)
          return { text: JSON.stringify({ output: 'The metric increased by 8%.' }) }
        },
        synthesis: ({ messages }) => {
          assert.ok(messages.some((item) => item.content.includes('"taskId":"single-analysis"')))
          return { text: 'The metric increased by 8%.' }
        },
      },
    },
  })

  const result = await request({ database, registry, message: 'Analyze this metric.' })

  assert.equal(result.execution.status, 'completed')
  assert.deepEqual(calls.map(({ stage }) => stage).sort(), ['understanding', 'planning', 'task_execution', 'task_verification', 'synthesis'].sort())
  assert.equal(database.state.agentRuns.length, 1)
  assert.equal(database.state.agentRuns[0].agentId, 'research-reasoning')
  assert.equal(database.state.agentRuns[0].status, 'completed')
})

test('independent planned tasks are both dispatched and remain independently tracked', async () => {
  const database = createDatabase()
  const plan = {
    tasks: [task('first-result'), task('second-result')],
  }
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({
            goal: 'Compare two independent items.',
            deliverables: ['First analysis', 'Second analysis'],
          })),
        }),
        planning: () => ({ text: JSON.stringify(plan) }),
      },
    },
  })

  const result = await request({ database, registry, message: 'Analyze both items independently.' })

  assert.equal(result.execution.status, 'completed')
  assert.equal(calls.filter(({ stage }) => stage === 'task_execution').length, 2)
  assert.deepEqual(database.state.agentRuns.map(({ input }) => input.dependencyOutputs), [{}, {}])
  assert.deepEqual(database.state.agentRuns.map(({ status }) => status), ['completed', 'completed'])
})

test('ambiguous, conflicting, and missing-source requests stop before planning', async (t) => {
  const cases = [
    {
      name: 'ambiguous objective',
      message: 'Can you make this better?',
      objective: objective({
        missingInformation: [{
          item: 'The item to improve',
          reason: 'No content or outcome was supplied.',
          requiredFor: 'drafting',
          clarificationQuestion: 'What would you like me to improve, and what outcome are you aiming for?',
          safeAssumption: '',
        }],
      }),
      expected: /what would you like me to improve/i,
    },
    {
      name: 'conflicting requirements',
      message: 'Write a report under 100 words and at least 500 words.',
      objective: objective({
        ambiguities: [{
          kind: 'conflict',
          description: 'The requested word limits are incompatible.',
          clarificationQuestion: 'Which word limit should I follow?',
          blocksDrafting: false,
          blocksExecution: false,
        }],
      }),
      expected: /which word limit should i follow/i,
    },
    {
      name: 'missing document',
      message: 'Summarize the report for me.',
      objective: objective({
        missingInformation: [{
          item: 'The report',
          reason: 'No source document was supplied.',
          requiredFor: 'drafting',
          clarificationQuestion: 'Please attach or paste the report.',
          safeAssumption: '',
        }],
      }),
      expected: /attach or paste the report/i,
    },
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const database = createDatabase()
      const { registry, calls } = createRegistry({
        handlers: { 'mock-primary': { understanding: () => ({ text: JSON.stringify(scenario.objective) }) } },
      })

      const result = await request({ database, registry, message: scenario.message })

      assert.deepEqual(calls.map(({ stage }) => stage), ['understanding'])
      assert.match(result.reply, scenario.expected)
      assert.equal(database.state.agentRuns.length, 0)
      assert.equal(database.state.persistedTasks.length, 0)
      assert.equal(database.state.commits, 1)
    })
  }
})

test('execution-only missing information allows a draft and records a pre-execution question', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({
            goal: 'Draft a message.',
            deliverables: ['A message draft'],
            missingInformation: [{
              item: 'Recipient',
              reason: 'The recipient is needed to send the message, not to draft it.',
              requiredFor: 'execution',
              clarificationQuestion: 'Who should receive the message?',
              safeAssumption: 'Use a placeholder recipient in the draft.',
            }],
            riskClassification: 'high',
          })),
        }),
        synthesis: ({ messages }) => {
          assert.ok(messages.some((item) => item.content.includes('Who should receive the message?')))
          assert.ok(messages.some((item) => item.content.includes('high-impact or irreversible action')))
          return { text: 'Drafted with a placeholder; no message was sent.' }
        },
      },
    },
  })

  const result = await request({ database, registry, message: 'Draft and send a message about the launch.' })

  assert.deepEqual(calls.map(({ stage }) => stage), ['understanding', 'synthesis'])
  assert.match(result.reply, /no message was sent/i)
  assert.equal(database.state.agentRuns.length, 0)
})

test('provider retry is bounded to one fallback during structured understanding', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    ids: ['mock-primary', 'mock-fallback', 'mock-third'],
    handlers: {
      'mock-primary': {
        understanding: () => {
          throw new ProviderError('Primary unavailable', { provider: 'mock-primary', retryable: true, status: 503 })
        },
      },
    },
  })

  const result = await request({ database, registry, message: 'What is a database index?' })

  assert.deepEqual(calls.map(({ id, stage }) => `${id}:${stage}`), [
    'mock-primary:understanding',
    'mock-fallback:understanding',
    'mock-fallback:synthesis',
  ])
  assert.equal(result.provider, 'mock-fallback')
  assert.equal(database.state.modelUsage.length, 3)
})

test('conversation history and project memory reach every applicable model stage', async () => {
  const database = createDatabase({
    history: [{ role: 'user', content: 'The launch targets small businesses.' }],
    memories: [
      { project_id: PROJECT_ID, kind: 'project_context', content: 'Use a conservative first-quarter budget.', source: 'planning' },
      { project_id: null, kind: 'preference', content: 'Prefer concise summaries.', source: 'settings' },
    ],
  })
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({
            goal: 'Prepare a project launch plan.',
            deliverables: ['Launch plan', 'Risk summary'],
            planningRequired: true,
          })),
        }),
      },
    },
  })

  const result = await request({
    database,
    registry,
    message: 'Prepare and analyze a launch plan with milestones, risks, owners, timeline, and success measures.',
  })

  for (const stage of ['understanding', 'planning', 'task_execution', 'synthesis']) {
    const call = calls.find((item) => item.stage === stage)
    assert.ok(call, `Expected ${stage} stage to run`)
    assert.ok(call.messages.some((item) => item.content.includes('The launch targets small businesses.')))
    assert.ok(call.messages.some((item) => item.content.includes('Selected project context') &&
      item.content.includes('Use a conservative first-quarter budget.')))
    assert.ok(call.messages.some((item) => item.content.includes('Retrieved global user memories') &&
      item.content.includes('Prefer concise summaries.')))
    assert.ok(call.messages.some((item) => item.content.includes('Using memories:')))
  }
  assert.ok(result.memoriesUsed.some(({ content }) => content === 'Prefer concise summaries.'))
})

test("a short reply is contextualized as an answer to Biz's latest question", async () => {
  const database = createDatabase({
    history: [
      { role: 'user', content: 'Help me plan the product launch.' },
      { role: 'assistant', content: 'When should the launch happen?' },
    ],
  })
  const { registry, calls } = createRegistry()

  await request({ database, registry, message: 'Next Friday.' })

  const understanding = calls.find(({ stage }) => stage === 'understanding')
  const followUpContext = understanding.messages.find(({ content }) =>
    content.includes('Follow-up context from this conversation'))
  assert.ok(followUpContext)
  assert.match(followUpContext.content, /Help me plan the product launch/)
  assert.match(followUpContext.content, /When should the launch happen\?/)
  assert.match(followUpContext.content, /continue without asking the user to repeat/)
})

test('durable preference memories are saved automatically after a successful chat', async () => {
  const database = createDatabase()
  const { registry } = createRegistry()

  await request({ database, registry, message: 'I like simple English.' })

  assert.deepEqual(database.state.persistedMemories.map(({ kind, content, projectId }) => ({
    kind,
    content,
    projectId,
  })), [{
    kind: 'preference',
    content: 'Likes simple English',
    projectId: null,
  }])
})

test('repeated invalid ObjectiveSpec output uses safe conversational handling without planning', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    handlers: { 'mock-primary': { understanding: () => ({ text: '{"goal":"incomplete"}' }) } },
  })

  const result = await request({ database, registry, message: 'What can you do?' })

  assert.deepEqual(calls.map(({ stage }) => stage), ['understanding', 'understanding', 'synthesis'])
  assert.match(result.reply, /Here is the requested response/)
  assert.equal(database.state.agentRuns.length, 0)
  assert.equal(database.state.persistedMessages.length, 2)
  assert.equal(database.state.persistedTasks.length, 0)
  assert.ok(calls.at(-1).messages.some(({ content }) => content.includes('could not validate its response')))
})

test('invalid PlanGraphs are rejected before agent assignment and persistence', async (t) => {
  const invalidGraphs = [
    {
      name: 'cyclic dependencies',
      graph: {
        tasks: [
          task('first', { dependencies: ['second'] }),
          task('second', { dependencies: ['first'] }),
        ],
      },
      error: /dependency cycle/,
    },
    {
      name: 'nonexistent tool',
      graph: {
        tasks: [task('bad', {
          type: 'tool',
          requiredCapability: 'tool_execution',
          specialistRole: 'execution',
          requiredInputs: [{
            kind: 'tool_output',
            description: 'Result from the requested action.',
            toolId: 'unregistered-phase-two-test-tool',
          }],
          toolInput: {},
        })],
      },
      error: /references a nonexistent tool/,
    },
  ]

  for (const scenario of invalidGraphs) {
    await t.test(scenario.name, async () => {
      const database = createDatabase()
      const { registry, calls } = createRegistry({
        handlers: {
          'mock-primary': {
            understanding: () => ({
              text: JSON.stringify(objective({ planningRequired: true, deliverables: ['Plan'] })),
            }),
            planning: () => ({ text: JSON.stringify(scenario.graph) }),
          },
        },
      })

      await assert.rejects(
        request({ database, registry, message: 'Prepare a multi-step plan with clear outputs.' }),
        scenario.error,
      )

      assert.equal(calls[0].stage, 'understanding')
      assert.equal(calls.filter(({ stage }) => stage === 'planning').length, 2)
      assert.equal(database.state.agentRuns.length, 0)
      assert.equal(database.state.commits, 0)
      assert.equal(database.state.persistedTasks.length, 0)
    })
  }
})

test('invalid specialist output exhausts bounded attempts and cannot be synthesized as success', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({ planningRequired: true, deliverables: ['One analysis'] })),
        }),
        planning: () => ({ text: JSON.stringify({ tasks: [task('bad-output', { maxAttempts: 2 })] }) }),
        task_execution: () => ({ text: 'not JSON' }),
      },
    },
  })

  const result = await request({ database, registry, message: 'Analyze this request.' })

  assert.equal(result.execution.status, 'failed')
  assert.equal(calls.filter(({ stage }) => stage === 'task_execution').length, 2)
  assert.equal(calls.some(({ stage }) => stage === 'synthesis'), false)
  assert.equal(database.state.agentRuns.length, 2)
  assert.ok(database.state.agentRuns.every(({ status }) => status === 'failed'))
  assert.match(result.reply, /cannot report this work as complete/i)
  assert.equal(database.state.auditEvents[0][1], 'conversation.message.execution_incomplete')
})

test('unauthorized tool plans are recorded as failed without running the tool', async () => {
  let executions = 0
  const unregister = registerMockAction('orchestrator-unauthorized-test', {
    permissions: ['tool:admin'],
    requiresApproval: false,
    execute: async () => {
      executions += 1
      return { accepted: true }
    },
  })
  try {
    const database = createDatabase()
    const { registry, calls } = createRegistry({
      handlers: {
        'mock-primary': {
          understanding: () => ({
            text: JSON.stringify(objective({
              goal: 'Perform an external action.',
              deliverables: ['Action result'],
              planningRequired: true,
              riskClassification: 'low',
              requiresExternalAction: true,
            })),
          }),
          planning: () => ({ text: JSON.stringify(toolGraph('orchestrator-unauthorized-test')) }),
        },
      },
    })

    const result = await request({
      database,
      registry,
      message: 'Perform the requested action.',
      skillResolver: allowListedToolSkill('orchestrator-unauthorized-test'),
    })

    assert.equal(result.execution.status, 'failed')
    assert.equal(executions, 0)
    assert.equal(database.state.toolExecutions.length, 0)
    assert.equal(database.state.agentRuns[0].status, 'failed')
    assert.equal(calls.some(({ stage }) => stage === 'synthesis'), false)
  } finally {
    unregister()
  }
})

test('approval-required tool tasks pause and do not claim the action happened', async () => {
  let executions = 0
  const unregister = registerMockAction('orchestrator-approval-test', {
    execute: async () => {
      executions += 1
      return { accepted: true }
    },
  })
  try {
    const database = createDatabase()
    const { registry, calls } = createRegistry({
      handlers: {
        'mock-primary': {
          understanding: () => ({
            text: JSON.stringify(objective({
              goal: 'Perform an external action.',
              deliverables: ['Action result'],
              planningRequired: true,
              riskClassification: 'high',
              requiresExternalAction: true,
            })),
          }),
          planning: () => ({ text: JSON.stringify(toolGraph('orchestrator-approval-test')) }),
        },
      },
    })

    const result = await request({
      database,
      registry,
      message: 'Perform the requested action.',
      skillResolver: allowListedToolSkill('orchestrator-approval-test'),
    })

    assert.equal(result.execution.status, 'awaiting_approval')
    assert.equal(executions, 0)
    assert.equal(database.state.toolExecutions[0].status, 'pending_approval')
    assert.equal(database.state.approvals[0].status, 'pending')
    assert.equal(database.state.agentRuns[0].status, 'waiting_approval')
    assert.equal(calls.some(({ stage }) => stage === 'synthesis'), false)
    assert.match(result.reply, /approval was created/i)
  } finally {
    unregister()
  }
})

test('LinkedIn post requests create an approval with the exact preview before execution', async () => {
  const postText = 'Biz is launching: an AI that never sleeps.'
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({
            goal: 'Publish a LinkedIn launch post.',
            deliverables: ['LinkedIn post published'],
            planningRequired: false,
            requiresExternalAction: true,
          })),
        }),
        planning: () => ({
          text: JSON.stringify({
            tasks: [task('publish-linkedin-post', {
              description: 'Prepare and submit the launch post for approval.',
              type: 'tool',
              requiredInputs: [{
                kind: 'tool_output',
                description: 'LinkedIn post publishing result.',
                toolId: 'linkedin_post',
              }],
              expectedOutput: 'The post is published after approval.',
              acceptanceCriteria: ['The exact post text is approved before publication.'],
              riskClassification: 'medium',
              requiredCapability: 'tool_execution',
              specialistRole: 'execution',
              toolInput: { text: postText },
            })],
          }),
        }),
      },
    },
  })

  const result = await request({
    database,
    registry,
    message: 'Make me a LinkedIn post about launching Biz.',
    skillResolver: async () => [],
  })

  assert.equal(result.execution.status, 'awaiting_approval')
  assert.ok(calls.some(({ stage }) => stage === 'planning'))
  assert.equal(database.state.toolExecutions[0].toolId, 'linkedin_post')
  assert.equal(database.state.toolExecutions[0].status, 'pending_approval')
  assert.equal(database.state.approvals[0].status, 'pending')
  assert.ok(database.state.auditEvents.some((event) => event[1] === 'conversation.message.awaiting_approval'))
  assert.match(database.state.approvals[0].description, new RegExp(postText))
  assert.match(result.reply, /Draft ready in Approvals/)
  assert.match(result.reply, /\[Go to Approvals\]\(\/approvals\)/)
  assert.ok(result.reply.includes(postText))
})

test('inline LinkedIn post text goes directly to Approvals without a confirmation question', async () => {
  const postText = 'Hello world'
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        planning: () => ({ text: JSON.stringify(linkedInPostGraph('Text rewritten by the planner.')) }),
      },
    },
  })

  const result = await request({
    database,
    registry,
    message: 'Post this to LinkedIn now: Hello world',
    skillResolver: async () => [],
  })

  assert.equal(result.execution.status, 'awaiting_approval')
  assert.equal(database.state.approvals.length, 1)
  assert.deepEqual(database.state.toolExecutions[0].input, { text: postText })
  assert.equal(database.state.toolExecutions[0].status, 'pending_approval')
  assert.equal(database.state.approvals[0].status, 'pending')
  assert.match(result.reply, /Draft ready in Approvals/)
  assert.match(result.reply, /\[Go to Approvals\]\(\/approvals\)/)
  assert.ok(result.reply.includes(postText))
  assert.equal(calls.some(({ stage }) => stage === 'understanding'), false)
  assert.equal(calls.some(({ stage }) => stage === 'synthesis'), false)
  assert.doesNotMatch(result.reply, /clarify|approved the exact text/i)
})

test('post it now uses the preceding user message as the exact LinkedIn post text', async () => {
  const database = createDatabase({ history: [{ role: 'user', content: 'Hello world' }] })
  const { registry } = createRegistry({
    handlers: {
      'mock-primary': {
        planning: () => ({ text: JSON.stringify(linkedInPostGraph()) }),
      },
    },
  })

  const result = await request({
    database,
    registry,
    message: 'post it now',
    skillResolver: async () => [],
  })

  assert.equal(result.execution.status, 'awaiting_approval')
  assert.deepEqual(database.state.toolExecutions[0].input, { text: 'Hello world' })
  assert.equal(database.state.approvals[0].status, 'pending')
  assert.ok(result.reply.includes('Hello world'))
})

test('approval acknowledgement reuses the exact prior LinkedIn text and creates an approval', async () => {
  const postText = 'Hello world'
  const database = createDatabase({
    history: [
      { role: 'user', content: 'Post this to LinkedIn now: Hello world' },
      { role: 'assistant', content: 'Has the user approved the exact text for posting?' },
    ],
  })
  const { registry } = createRegistry({
    handlers: {
      'mock-primary': {
        planning: () => ({ text: JSON.stringify(linkedInPostGraph('Rewritten copy.')) }),
      },
    },
  })

  const result = await request({
    database,
    registry,
    message: 'Yes, I approve',
    skillResolver: async () => [],
  })

  assert.equal(result.execution.status, 'awaiting_approval')
  assert.deepEqual(database.state.toolExecutions[0].input, { text: postText })
  assert.equal(database.state.approvals[0].status, 'pending')
  assert.ok(result.reply.includes(postText))
})

test('bare LinkedIn post asks once for text, then creates the approval from the answer', async () => {
  const firstDatabase = createDatabase()
  const firstProvider = createRegistry()
  const firstResult = await request({
    database: firstDatabase,
    registry: firstProvider.registry,
    message: 'Post to LinkedIn',
    skillResolver: async () => [],
  })

  assert.equal(firstResult.reply, 'What text should I post?')
  assert.equal((firstResult.reply.match(/\?/g) || []).length, 1)
  assert.equal(firstDatabase.state.approvals.length, 0)
  assert.equal(firstProvider.calls.some(({ stage }) => stage === 'planning'), false)

  const database = createDatabase({ history: firstDatabase.state.persistedMessages })
  const { registry } = createRegistry({
    handlers: {
      'mock-primary': {
        planning: () => ({ text: JSON.stringify(linkedInPostGraph()) }),
      },
    },
  })
  const result = await request({
    database,
    registry,
    message: 'Hello world',
    skillResolver: async () => [],
  })

  assert.equal(result.execution.status, 'awaiting_approval')
  assert.deepEqual(database.state.toolExecutions[0].input, { text: 'Hello world' })
  assert.equal(database.state.approvals[0].status, 'pending')
  assert.ok(result.reply.includes('Hello world'))
})

test('LinkedIn approval preview and chat reply preserve the exact supplied text', async () => {
  const postText = 'Biz is your AI worker that never sleeps. Chat. Connect. Automate.'
  const database = createDatabase()
  const { registry } = createRegistry({
    handlers: {
      'mock-primary': {
        planning: () => ({ text: JSON.stringify(linkedInPostGraph('Rewritten copy.')) }),
      },
    },
  })

  const result = await request({
    database,
    registry,
    message: `Post this to LinkedIn now: ${postText}`,
    skillResolver: async () => [],
  })

  assert.deepEqual(database.state.toolExecutions[0].input, { text: postText })
  assert.ok(database.state.approvals[0].description.includes(postText))
  assert.ok(result.reply.includes(postText))
})

test('LinkedIn post text does not bypass a required schedule clarification', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry()

  const result = await request({
    database,
    registry,
    message: 'Post to LinkedIn for one week: Hello world',
    skillResolver: async () => [],
  })

  assert.match(result.reply, /How many posts per week, and what time each day\?/)
  assert.equal(database.state.approvals.length, 0)
  assert.equal(calls.some(({ stage }) => stage === 'planning'), false)
})

test('parsed LinkedIn schedule is added to tool input before creating approval', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({
            goal: 'Schedule a LinkedIn post.',
            deliverables: ['Scheduled LinkedIn post'],
            planningRequired: true,
            requiresExternalAction: true,
          })),
        }),
        planning: () => ({
          text: JSON.stringify({
            tasks: [task('publish-linkedin-post', {
              type: 'tool',
              requiredInputs: [{
                kind: 'tool_output',
                description: 'LinkedIn post publishing result.',
                toolId: 'linkedin_post',
              }],
              requiredCapability: 'tool_execution',
              specialistRole: 'execution',
              toolInput: { text: 'Reworded by the planner.' },
            })],
          }),
        }),
      },
    },
  })

  const result = await request({
    database,
    registry,
    message: 'Schedule a LinkedIn post for tomorrow at 10:30am: Biz is live.',
    skillResolver: async () => [],
  })

  const submittedInput = database.state.toolExecutions[0].input
  assert.equal(result.execution.status, 'awaiting_approval')
  assert.equal(submittedInput.text, 'Biz is live.')
  assert.equal(submittedInput.schedule.mode, 'scheduled')
  assert.equal(submittedInput.schedule.timezone, 'UTC')
  assert.ok(Date.parse(submittedInput.schedule.scheduledAt) > Date.now())
  assert.equal(database.state.approvals[0].status, 'pending')
  assert.ok(calls.find(({ stage }) => stage === 'planning').messages.some(({ content }) =>
    content.includes('"mode":"scheduled"')))
})

test('malformed planner fallback creates a complete LinkedIn approval task', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({
            goal: 'Publish a LinkedIn post.',
            deliverables: ['LinkedIn post published'],
            requiresExternalAction: true,
          })),
        }),
        planning: () => ({ text: '{"tasks":' }),
      },
    },
  })

  const result = await request({
    database,
    registry,
    message: 'Post to LinkedIn: Biz is live.',
    skillResolver: async () => [],
  })

  assert.equal(calls.filter(({ stage }) => stage === 'planning').length, 2)
  assert.equal(result.execution.status, 'awaiting_approval')
  assert.equal(result.execution.tasks[0].taskId, 'tool-task-1')
  assert.equal(database.state.toolExecutions[0].toolId, 'linkedin_post')
  assert.deepEqual(database.state.toolExecutions[0].input, { text: 'Biz is live.' })
  assert.equal(database.state.approvals[0].status, 'pending')
})

test('LinkedIn post plans with malformed acceptance criteria still reach approval', async () => {
  const cases = [
    { name: 'string', value: 'Draft ready', expected: ['Draft ready'] },
    { name: 'missing', expected: ['Tool result ready for approval'] },
    { name: 'empty', value: [], expected: ['Tool result ready for approval'] },
    { name: 'null', value: null, expected: ['Tool result ready for approval'] },
  ]

  for (const scenario of cases) {
    const database = createDatabase()
    const publishTask = task('publish-linkedin-post', {
      type: 'tool',
      requiredInputs: [{
        kind: 'tool_output',
        description: 'LinkedIn post publishing result.',
        toolId: 'linkedin_post',
      }],
      requiredCapability: 'tool_execution',
      specialistRole: 'execution',
      toolInput: { text: 'Biz is launching: an AI that never sleeps.' },
    })
    if (Object.hasOwn(scenario, 'value')) publishTask.acceptanceCriteria = scenario.value
    else delete publishTask.acceptanceCriteria

    const { registry } = createRegistry({
      handlers: {
        'mock-primary': {
          understanding: () => ({
            text: JSON.stringify(objective({
              goal: 'Publish a LinkedIn launch post.',
              deliverables: ['LinkedIn post published'],
              requiresExternalAction: true,
            })),
          }),
          planning: () => ({ text: JSON.stringify({ tasks: [publishTask] }) }),
        },
      },
    })
    const result = await request({
      database,
      registry,
      message: 'Make me a LinkedIn post about launching Biz.',
      skillResolver: async () => [{
        name: 'manage-linkedin',
        description: 'Create and manage LinkedIn posts.',
        version: '1.0.0',
        body: 'Prepare LinkedIn posts and submit them for approval before publishing.',
        tools: ['linkedin_post'],
        enabled: true,
      }],
    })

    assert.equal(result.execution.status, 'awaiting_approval', scenario.name)
    assert.deepEqual(database.state.agentRuns[0].input.task.acceptanceCriteria, scenario.expected)
    assert.equal(database.state.toolExecutions[0].status, 'pending_approval')
    assert.equal(database.state.approvals[0].status, 'pending')
    assert.match(result.reply, /Draft ready in Approvals/)
    assert.ok(result.reply.includes('Biz is launching: an AI that never sleeps.'))
  }
})

test('dependent Gmail tool plans collapse into one generic approval task without a skill', async () => {
  const toolInput = {
    to: 'daniel@example.com',
    subject: 'Biz launch',
    body: 'Biz is launching: an AI that never sleeps.',
  }
  const unregister = registerTool({
    id: 'gmail_send',
    name: 'Send Gmail Message',
    connector: 'gmail',
    description: 'Send an email after user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', minLength: 1 },
        subject: { type: 'string', minLength: 1 },
        body: { type: 'string', minLength: 1 },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    permissions: ['tool:approved'],
    requiresApproval: true,
    validate: (input) => ['to', 'subject', 'body'].every((key) =>
      typeof input?.[key] === 'string' && input[key].trim().length > 0),
    describeAction: (input) => `Send email to ${input.to}: ${input.subject}\n\n${input.body}`,
    execute: async () => ({ sent: true }),
  })
  try {
    const database = createDatabase()
    const { registry } = createRegistry({
      handlers: {
        'mock-primary': {
          understanding: () => ({
            text: JSON.stringify(objective({
              goal: 'Send an email announcing the Biz launch.',
              deliverables: ['Email sent'],
              requiresExternalAction: true,
            })),
          }),
          planning: () => ({
            text: JSON.stringify({
              tasks: [
                task('draft-email', {
                  description: 'Draft the Biz launch email.',
                  acceptanceCriteria: 'Email is clear and concise.',
                  toolInput: { body: toolInput.body },
                }),
                task('send-email', {
                  description: 'Send the email after user approval.',
                  type: 'tool',
                  requiredInputs: [{
                    kind: 'tool_output',
                    description: 'Gmail delivery result.',
                    toolId: 'gmail_send',
                  }],
                  dependencies: ['draft-email'],
                  acceptanceCriteria: 'Email sent after approval.',
                  toolInput: { ...toolInput, body: '' },
                }),
              ],
            }),
          }),
        },
      },
    })
    const result = await request({
      database,
      registry,
      message: 'Send an email to Daniel about launching Biz.',
      skillResolver: async () => [],
    })

    assert.equal(result.execution.status, 'awaiting_approval')
    assert.equal(result.execution.tasks.length, 1)
    assert.equal(result.execution.tasks[0].taskId, 'tool-task-1')
    assert.equal(database.state.toolExecutions.length, 1)
    assert.equal(database.state.toolExecutions[0].toolId, 'gmail_send')
    assert.deepEqual(database.state.toolExecutions[0].input, toolInput)
    assert.equal(database.state.toolExecutions[0].status, 'pending_approval')
    assert.equal(database.state.approvals[0].status, 'pending')
    assert.match(database.state.approvals[0].description, /Biz is launching/)
    assert.match(result.reply, /Send Gmail Message/)
    assert.match(result.reply, /Review the exact preview in \[Approvals\]/)
    assert.equal(database.state.agentRuns.length, 1)
  } finally {
    unregister()
  }
})

test('malformed planner fallback can create approval for a registered Gmail-shaped tool', async () => {
  const unregister = registerTool({
    id: 'gmail_send',
    name: 'Send Gmail Message',
    connector: 'gmail',
    description: 'Send an email after user approval.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    permissions: ['tool:approved'],
    requiresApproval: true,
    validate: (input) => typeof input?.text === 'string' && input.text.trim().length > 0,
    execute: async () => ({ sent: true }),
  })
  try {
    const database = createDatabase()
    const { registry } = createRegistry({
      handlers: {
        'mock-primary': {
          understanding: () => ({
            text: JSON.stringify(objective({
              goal: 'Send an email to Daniel.',
              deliverables: ['Email sent'],
              requiresExternalAction: true,
            })),
          }),
          planning: () => ({ text: 'not valid planner JSON' }),
        },
      },
    })

    const result = await request({
      database,
      registry,
      message: 'Send email to Daniel',
      skillResolver: async () => [],
    })

    assert.equal(result.execution.status, 'awaiting_approval')
    assert.equal(result.execution.tasks[0].taskId, 'tool-task-1')
    assert.equal(database.state.toolExecutions[0].toolId, 'gmail_send')
    assert.deepEqual(database.state.toolExecutions[0].input, { text: 'Send email to Daniel' })
    assert.equal(database.state.approvals[0].status, 'pending')
  } finally {
    unregister()
  }
})

test('execution-critical missing information blocks tool dispatch before agent assignment', async () => {
  let executions = 0
  const unregister = registerMockAction('orchestrator-missing-input-test', {
    execute: async () => {
      executions += 1
      return { accepted: true }
    },
  })
  try {
    const database = createDatabase()
    const { registry, calls } = createRegistry({
      handlers: {
        'mock-primary': {
          understanding: () => ({
            text: JSON.stringify(objective({
              goal: 'Send the requested message.',
              deliverables: ['Message delivery'],
              planningRequired: true,
              requiresExternalAction: true,
              missingInformation: [{
                item: 'Recipient',
                reason: 'The recipient is required to send the message.',
                requiredFor: 'execution',
                clarificationQuestion: 'Who should receive the message?',
                safeAssumption: '',
              }],
            })),
          }),
          planning: () => ({ text: JSON.stringify(toolGraph('orchestrator-missing-input-test')) }),
        },
      },
    })

    const result = await request({
      database,
      registry,
      message: 'Send the message.',
      skillResolver: allowListedToolSkill('orchestrator-missing-input-test'),
    })

    assert.equal(result.execution.status, 'awaiting_input')
    assert.equal(executions, 0)
    assert.equal(database.state.agentRuns.length, 0)
    assert.equal(database.state.toolExecutions.length, 0)
    assert.match(result.reply, /Who should receive the message/i)
    assert.equal(calls.some(({ stage }) => stage === 'synthesis'), false)
  } finally {
    unregister()
  }
})

test('retry-safe tool failures retry within the specialist budget and require result verification', async () => {
  let executions = 0
  const unregister = registerMockAction('orchestrator-retry-safe-test', {
    requiresApproval: false,
    retrySafe: true,
    verifyResult: (result) => result?.accepted === true,
    execute: async () => {
      executions += 1
      if (executions === 1) throw new Error('Deterministic tool failure.')
      return { accepted: true }
    },
  })
  try {
    const database = createDatabase()
    const { registry } = createRegistry({
      handlers: {
        'mock-primary': {
          understanding: () => ({
            text: JSON.stringify(objective({
              goal: 'Perform an external action.',
              deliverables: ['Action result'],
              planningRequired: true,
              requiresExternalAction: true,
            })),
          }),
          planning: () => ({ text: JSON.stringify(toolGraph('orchestrator-retry-safe-test', 5)) }),
        },
      },
    })

    const result = await request({
      database,
      registry,
      message: 'Perform the requested action.',
      skillResolver: allowListedToolSkill('orchestrator-retry-safe-test'),
    })

    assert.equal(result.execution.status, 'completed')
    assert.equal(executions, 2, 'execution agent budget caps attempts at two')
    assert.deepEqual(database.state.toolExecutions.map(({ status }) => status), ['failed', 'completed'])
    assert.deepEqual(database.state.agentRuns.map(({ status }) => status), ['failed', 'completed'])
    assert.equal(result.execution.tasks[0].status, 'verified')
    assert.equal(result.execution.tasks[0].evidence[0].verified, true)
  } finally {
    unregister()
  }
})

test('tool responses without a registered verifier are not reported as completed actions', async () => {
  let executions = 0
  const unregister = registerMockAction('orchestrator-unverified-tool-test', {
    requiresApproval: false,
    execute: async () => {
      executions += 1
      return { accepted: true }
    },
  })
  try {
    const database = createDatabase()
    const { registry, calls } = createRegistry({
      handlers: {
        'mock-primary': {
          understanding: () => ({
            text: JSON.stringify(objective({
              goal: 'Perform an external action.',
              deliverables: ['Action result'],
              planningRequired: true,
              requiresExternalAction: true,
            })),
          }),
          planning: () => ({ text: JSON.stringify(toolGraph('orchestrator-unverified-tool-test')) }),
        },
      },
    })

    const result = await request({
      database,
      registry,
      message: 'Perform the requested action.',
      skillResolver: allowListedToolSkill('orchestrator-unverified-tool-test'),
    })

    assert.equal(executions, 1)
    assert.equal(result.execution.status, 'partial')
    assert.equal(result.execution.tasks[0].status, 'executed')
    assert.match(result.reply, /outcome was not verified/i)
    assert.equal(calls.some(({ stage }) => stage === 'synthesis'), false)
  } finally {
    unregister()
  }
})

test('interrupted orchestrator execution reports completed evidence without claiming overall success', async () => {
  const controller = new AbortController()
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({
            goal: 'Complete independent analyses.',
            deliverables: ['First analysis', 'Second analysis'],
          })),
        }),
        planning: () => ({ text: JSON.stringify({ tasks: [task('first'), task('second')] }) }),
        task_execution: () => {
          controller.abort(new Error('Request interrupted.'))
          return { text: JSON.stringify({ output: 'A completed structured result.' }) }
        },
      },
    },
  })

  const result = await request({
    database,
    registry,
    message: 'Analyze the two items.',
    signal: controller.signal,
  })

  assert.equal(result.execution.status, 'interrupted')
  assert.match(result.reply, /execution was interrupted/i)
  assert.equal(calls.some(({ stage }) => stage === 'synthesis'), false)
  assert.ok(result.execution.tasks.every(({ status }) => ['verified', 'interrupted'].includes(status)))
})

test('failed final synthesis does not persist the plan or mark the request successful', async () => {
  const database = createDatabase()
  const { registry, calls } = createRegistry({
    handlers: {
      'mock-primary': {
        understanding: () => ({
          text: JSON.stringify(objective({ planningRequired: true, deliverables: ['Plan'] })),
        }),
        synthesis: () => {
          throw new ProviderError('Synthesis rejected', { provider: 'mock-primary', retryable: false, status: 502 })
        },
      },
    },
  })

  await assert.rejects(
    request({ database, registry, message: 'Analyze requirements and prepare a multi-stage recommendation.' }),
    /Synthesis rejected/,
  )

  assert.deepEqual(calls.map(({ stage }) => stage).sort(), [
    'planning',
    'synthesis',
    'task_execution',
    'task_execution',
    'task_execution',
    'task_verification',
    'task_verification',
    'task_verification',
    'understanding',
  ].sort())
  assert.equal(database.state.agentRuns[0].status, 'completed', 'the research stage itself completed')
  assert.equal(database.state.commits, 0)
  assert.equal(database.state.persistedMessages.length, 0)
  assert.equal(database.state.persistedTasks.length, 0)
  assert.equal(database.state.auditEvents.length, 0)
})

test('external-action requests without a planned tool do not claim completion', async () => {
  let toolExecutions = 0
  const unregister = registerTool({
    id: 'phase-two-test-send-message',
    description: 'Mock external message action.',
    inputSchema: { type: 'object', properties: { recipient: { type: 'string' } } },
    permissions: ['tool:approved'],
    validate: (input) => typeof input?.recipient === 'string',
    execute: async () => {
      toolExecutions += 1
      return { sent: true }
    },
  })

  try {
    const database = createDatabase()
    const { registry, calls } = createRegistry({
      handlers: {
        'mock-primary': {
          understanding: () => ({
            text: JSON.stringify(objective({
              goal: 'Send the requested message.',
              deliverables: ['Message sent'],
              requiresExternalAction: true,
            })),
          }),
          synthesis: () => ({ text: 'I sent the message.' }),
        },
      },
    })

    const result = await request({ database, registry, message: 'Send Alex the launch update.' })

    assert.equal(calls[0].stage, 'understanding')
    assert.equal(calls[1].stage, 'planning')
    assert.equal(calls.some(({ stage }) => stage === 'synthesis'), false)
    assert.match(result.reply, /No registered tool matched this external action/i)
    assert.doesNotMatch(result.reply, /sent the message/i)
    assert.equal(toolExecutions, 0)
    assert.equal(database.state.toolExecutions.length, 0)
    assert.ok(database.state.persistedTasks.length > 0)
  } finally {
    unregister()
  }
})
