import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createProjectTask,
  deleteProject,
  findProjectMention,
  getProjectDetails,
  parseCreateProjectRequest,
  persistTaskPlan,
} from './service.js'

function task(id, overrides = {}) {
  return {
    id,
    description: id,
    type: 'analysis',
    requiredInputs: [{ kind: 'user_request', description: 'Original request' }],
    dependencies: [],
    expectedOutput: `${id} output`,
    acceptanceCriteria: [`${id} is complete`],
    riskClassification: 'low',
    requiredCapability: 'reasoning',
    specialistRole: 'general',
    maxAttempts: 2,
    completionConditions: [`${id} output is present`],
    ...overrides,
  }
}

test('planned tasks stay in the selected owned project and preserve dependencies', async () => {
  const inserts = []
  const database = {
    release() {},
    async query(sql, values) {
      if (sql.includes('FROM projects')) return { rowCount: 1, rows: [{}] }
      inserts.push(values)
      return { rows: [{ id: `task-${inserts.length}` }] }
    },
  }
  const ids = await persistTaskPlan({
    userId: 'user-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    plan: {
      tasks: [
        task('research', { description: 'Research' }),
        task('implement', {
          description: 'Implement',
          type: 'drafting',
          dependencies: ['research'],
          requiredInputs: [{ kind: 'task_output', description: 'Research findings', sourceTaskId: 'research' }],
          requiredCapability: 'writing',
        }),
      ],
    },
    database,
  })

  assert.deepEqual(ids, ['task-1', 'task-2'])
  assert.deepEqual(inserts[0].slice(0, 3), ['user-1', 'project-1', 'Research'])
  assert.deepEqual(inserts[1][5], ['task-1'])
  const metadata = JSON.parse(inserts[1][6])
  assert.equal(metadata.source, 'chat_orchestration')
  assert.equal(metadata.conversationId, 'conversation-1')
  assert.equal(metadata.taskId, 'implement')
  assert.deepEqual(metadata.acceptanceCriteria, ['implement is complete'])
})

test('independent planned tasks remain independent when persisted', async () => {
  const inserts = []
  const database = {
    release() {},
    async query(sql, values) {
      if (sql.includes('FROM projects')) return { rowCount: 1, rows: [{}] }
      inserts.push(values)
      return { rows: [{ id: `task-${inserts.length}` }] }
    },
  }

  await persistTaskPlan({
    userId: 'user-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    plan: { tasks: [task('audience'), task('budget')] },
    database,
  })

  assert.deepEqual(inserts.map((values) => values[5]), [[], []])
})

test('planned task persistence rejects unowned projects before writing tasks', async () => {
  let inserted = false
  await assert.rejects(
    persistTaskPlan({
      userId: 'user-1',
      projectId: 'project-2',
      conversationId: 'conversation-1',
      plan: { tasks: [task('research')] },
      database: {
        release() {},
        async query(sql) {
          if (sql.includes('FROM projects')) return { rowCount: 0, rows: [] }
          inserted = true
          return { rows: [] }
        },
      },
    }),
    (error) => error.status === 404,
  )
  assert.equal(inserted, false)
})

test('task creation rejects duplicate dependencies before opening a transaction', async () => {
  let connected = false
  await assert.rejects(
    createProjectTask({
      userId: 'user-1',
      title: 'Blocked task',
      dependencies: ['task-1', 'task-1'],
      database: { connect: async () => { connected = true; throw new Error('unexpected connection') } },
    }),
    (error) => error.status === 400,
  )
  assert.equal(connected, false)
})

test('chat project commands and project mentions resolve to an owned project', async () => {
  assert.equal(parseCreateProjectRequest('Create project Stickman Videos'), 'Stickman Videos')
  assert.equal(parseCreateProjectRequest('Please set up a new project called Alpha Beta.'), 'Alpha Beta')
  assert.equal(parseCreateProjectRequest('Write a project update'), null)

  const project = await findProjectMention({
    userId: 'user-1',
    message: 'Draft a campaign for SkinSnap Sales this week.',
    database: {
      async query(sql, values) {
        assert.deepEqual(values, ['user-1'])
        assert.match(sql, /WHERE user_id = \$1/)
        return { rows: [
          { id: 'short', name: 'SkinSnap' },
          { id: 'project-1', name: 'SkinSnap Sales' },
          { id: 'other-user', name: 'Campaign' },
        ] }
      },
    },
  })
  assert.deepEqual(project, { id: 'project-1', name: 'SkinSnap Sales' })
})

test('project details combine owned tasks, jobs, memories, and skills used', async () => {
  const queries = []
  const details = await getProjectDetails({
    userId: 'user-1',
    projectId: 'project-1',
    database: {
      async query(sql, values) {
        queries.push(sql)
        if (sql.includes('FROM projects')) return { rows: [{ id: 'project-1', name: 'SkinSnap Sales' }] }
        if (sql.includes('FROM tasks')) return { rows: [{ id: 'task-1', status: 'pending' }] }
        if (sql.includes('FROM jobs')) return { rows: [{ id: 'job-1', status: 'completed' }] }
        if (sql.includes('FROM memory_records')) return { rows: [{ id: 'memory-1', content: 'Sells in UK' }] }
        if (sql.includes('FROM conversations')) return { rows: [{ name: 'example-sell-skinsnap' }] }
        assert.fail(`Unexpected query: ${sql}`)
      },
    },
  })
  assert.equal(details.name, 'SkinSnap Sales')
  assert.equal(details.tasks.length, 1)
  assert.equal(details.jobs.length, 1)
  assert.equal(details.memories.length, 1)
  assert.deepEqual(details.skillsUsed, ['example-sell-skinsnap'])
  assert.equal(queries.length, 5)
})

test('project deletion preserves other tasks and removes dangling dependencies', async () => {
  const calls = []
  const deleted = await deleteProject({
    userId: 'user-1',
    projectId: 'project-1',
    database: {
      async connect() {
        return {
          async query(sql, values = []) {
            calls.push({ sql, values })
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] }
            if (sql.includes('SELECT id, name FROM projects')) return { rowCount: 1, rows: [{ id: 'project-1', name: 'SkinSnap Sales' }] }
            if (sql.includes('SELECT id FROM tasks')) return { rowCount: 1, rows: [{ id: 'task-1' }] }
            if (sql.includes('UPDATE tasks AS dependent')) return { rowCount: 1, rows: [] }
            if (sql.includes('DELETE FROM projects')) return { rowCount: 1, rows: [] }
            if (sql.includes('INSERT INTO audit_logs')) return { rowCount: 1, rows: [] }
            assert.fail(`Unexpected query: ${sql}`)
          },
          release() {},
        }
      },
    },
  })
  assert.equal(deleted, true)
  const dependencyUpdate = calls.find(({ sql }) => sql.includes('UPDATE tasks AS dependent'))
  assert.deepEqual(dependencyUpdate.values, [['task-1'], 'user-1', 'project-1'])
  assert.ok(calls.some(({ sql }) => sql.includes('DELETE FROM projects')))
})
