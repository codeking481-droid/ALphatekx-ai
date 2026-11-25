import { pool } from '../db/pool.js'
import { audit } from '../observability/audit.js'
import { topologicalOrder, validatePlanGraph } from '../intelligence/plan-graph.js'

export async function createProject({ userId, name, description = '', database = pool }) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 160) {
    throw Object.assign(new Error('Project name must be between 1 and 160 characters.'), { status: 400 })
  }
  if (typeof description !== 'string' || description.length > 8000) {
    throw Object.assign(new Error('Project description must be a string of up to 8000 characters.'), { status: 400 })
  }
  const { rows } = await database.query(
    `INSERT INTO projects (user_id, name, description) VALUES ($1, $2, $3)
     RETURNING id, name, description, created_at, updated_at`,
    [userId, name.trim(), description.trim()],
  )
  return rows[0]
}

export async function listProjects(userId, database = pool) {
  const { rows } = await database.query(
    `SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
       (SELECT count(*)::int FROM tasks t WHERE t.user_id = p.user_id AND t.project_id = p.id) AS task_count,
       (SELECT count(*)::int FROM tasks t WHERE t.user_id = p.user_id AND t.project_id = p.id AND t.status = 'completed') AS completed_task_count,
       (SELECT count(*)::int FROM jobs j
        LEFT JOIN conversations c ON c.id = j.conversation_id AND c.user_id = j.user_id
        WHERE j.user_id = p.user_id AND (j.input->>'project_id' = p.id::text OR c.project_id = p.id)) AS job_count
     FROM projects p WHERE p.user_id = $1 ORDER BY p.updated_at DESC`,
    [userId],
  )
  return rows
}

export async function getProjectDetails({ userId, projectId, database = pool }) {
  const project = await database.query(
    'SELECT id, name, description, created_at, updated_at FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId],
  )
  if (!project.rows[0]) return null
  const [tasks, jobs, memories, skills] = await Promise.all([
    database.query(
      `SELECT id, project_id, title, description, status, dependencies, position, created_at, updated_at
       FROM tasks WHERE user_id = $1 AND project_id = $2 ORDER BY position, created_at`,
      [userId, projectId],
    ),
    database.query(
      `SELECT j.id, j.status, j.progress, j.created_at, j.updated_at
       FROM jobs j
       LEFT JOIN conversations c ON c.id = j.conversation_id AND c.user_id = j.user_id
       WHERE j.user_id = $1 AND (j.input->>'project_id' = $2 OR c.project_id = $2)
       ORDER BY j.created_at DESC LIMIT 50`,
      [userId, projectId],
    ),
    database.query(
      `SELECT id, kind, content, created_at, updated_at
       FROM memory_records WHERE user_id = $1 AND project_id = $2
       ORDER BY updated_at DESC LIMIT 50`,
      [userId, projectId],
    ),
    database.query(
      `SELECT DISTINCT m.metadata->'skill'->>'name' AS name
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id AND m.user_id = c.user_id
       WHERE c.user_id = $1 AND c.project_id = $2 AND m.role = 'assistant'
         AND m.metadata->'skill'->>'name' IS NOT NULL
       ORDER BY name`,
      [userId, projectId],
    ),
  ])
  return {
    ...project.rows[0],
    tasks: tasks.rows,
    jobs: jobs.rows,
    memories: memories.rows,
    skillsUsed: skills.rows.map(({ name }) => name),
  }
}

export async function findProjectByName({ userId, name, database = pool }) {
  const { rows } = await database.query(
    'SELECT id, name FROM projects WHERE user_id = $1 AND lower(name) = lower($2) ORDER BY updated_at DESC LIMIT 1',
    [userId, name],
  )
  return rows[0] || null
}

export async function findProjectMention({ userId, message, database = pool }) {
  if (typeof message !== 'string' || !message.trim()) return null
  const { rows } = await database.query(
    'SELECT id, name FROM projects WHERE user_id = $1 ORDER BY length(name) DESC, updated_at DESC',
    [userId],
  )
  const text = message.toLowerCase()
  const matches = rows.filter(({ name }) => includesWholePhrase(text, name))
  if (!matches.length) return null
  const longest = Math.max(...matches.map(({ name }) => name.length))
  const strongest = matches.filter(({ name }) => name.length === longest)
  return strongest.length === 1 ? strongest[0] : null
}

export function parseCreateProjectRequest(message) {
  if (typeof message !== 'string') return null
  const match = /^\s*(?:please\s+)?(?:create|start|set up|make)\s+(?:a\s+)?(?:new\s+)?project(?:\s+(?:called|named))?\s+(.+?)\s*[.!?]*\s*$/i.exec(message)
  const name = match?.[1]?.trim().replace(/^["'](.+)["']$/, '$1').replace(/[.!?]+$/, '').trim()
  return name || null
}

function includesWholePhrase(text, phrase) {
  const normalized = String(phrase || '').trim().toLowerCase()
  if (normalized.length < 3) return false
  let start = text.indexOf(normalized)
  while (start !== -1) {
    const before = start === 0 ? '' : text[start - 1]
    const after = text[start + normalized.length] || ''
    if ((!before || !/[a-z0-9]/i.test(before)) && (!after || !/[a-z0-9]/i.test(after))) return true
    start = text.indexOf(normalized, start + 1)
  }
  return false
}

export async function deleteProject({ userId, projectId, database = pool }) {
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    const project = await client.query(
      'SELECT id, name FROM projects WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [projectId, userId],
    )
    if (!project.rowCount) {
      await client.query('ROLLBACK')
      return false
    }
    const tasks = await client.query(
      'SELECT id FROM tasks WHERE user_id = $1 AND project_id = $2',
      [userId, projectId],
    )
    if (tasks.rowCount) {
      await client.query(
        `UPDATE tasks AS dependent
         SET dependencies = ARRAY(
           SELECT dependency FROM unnest(dependent.dependencies) AS items(dependency)
           WHERE NOT (dependency = ANY($1::uuid[]))
         ), updated_at = now()
         WHERE dependent.user_id = $2 AND dependent.project_id IS DISTINCT FROM $3
           AND dependent.dependencies && $1::uuid[]`,
        [tasks.rows.map(({ id }) => id), userId, projectId],
      )
    }
    await client.query('DELETE FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId])
    await audit({
      userId,
      event: 'project.deleted',
      resourceType: 'project',
      resourceId: projectId,
      details: { name: project.rows[0].name, task_count: tasks.rowCount },
    }, client)
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function createProjectTask({ userId, projectId = null, title, description = '', dependencies = [], database = pool }) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 240) {
    throw Object.assign(new Error('Task title must be between 1 and 240 characters.'), { status: 400 })
  }
  if (typeof description !== 'string' || description.length > 8000) {
    throw Object.assign(new Error('Task description must be a string of up to 8000 characters.'), { status: 400 })
  }
  if (!Array.isArray(dependencies) || dependencies.length > 50 ||
    dependencies.some((id) => typeof id !== 'string') ||
    new Set(dependencies).size !== dependencies.length) {
    throw Object.assign(new Error('Task dependencies are invalid.'), { status: 400 })
  }
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    if (projectId) {
      const project = await client.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2 FOR UPDATE', [projectId, userId])
      if (!project.rowCount) throw new Error('Project not found.')
    }
    if (dependencies.length) {
      const owned = await client.query(
        'SELECT id FROM tasks WHERE user_id = $1 AND id = ANY($2::uuid[])',
        [userId, dependencies],
      )
      if (owned.rowCount !== new Set(dependencies).size) throw new Error('A task dependency was not found.')
    }
    const { rows } = await client.query(
      `INSERT INTO tasks (user_id, project_id, title, description, dependencies)
       VALUES ($1, $2, $3, $4, $5::uuid[]) RETURNING id, project_id, title, description, status, dependencies`,
      [userId, projectId, title.trim(), description.trim(), dependencies],
    )
    await client.query('COMMIT')
    return rows[0]
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function persistTaskPlan({
  userId,
  projectId = null,
  conversationId,
  plan,
  executionReport = null,
  objectiveId = null,
  planId = null,
  database,
}) {
  if (typeof database?.query !== 'function' || typeof database.release !== 'function') {
    throw new TypeError('Planned tasks must be persisted with a transaction-scoped database client.')
  }
  const graph = validatePlanGraph(plan)
  const executionStates = new Map((executionReport?.tasks || []).map((state) => [state.taskId, state]))
  if (executionReport && (executionStates.size !== graph.tasks.length ||
    graph.tasks.some((task) => !executionStates.has(task.id)))) {
    throw new Error('Execution report does not match the persisted PlanGraph.')
  }
  if (projectId) {
    const project = await database.query('SELECT 1 FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId])
    if (!project.rowCount) throw Object.assign(new Error('Project not found.'), { status: 404 })
  }
  const createdIds = new Map()
  for (const task of topologicalOrder(graph)) {
    const dependencies = task.dependencies.map((id) => createdIds.get(id))
    if (dependencies.some((id) => !id)) throw new Error(`Plan task "${task.id}" has an unresolved dependency.`)
    const metadata = {
      source: 'chat_orchestration',
      conversationId,
      taskId: task.id,
      type: task.type,
      requiredInputs: task.requiredInputs,
      expectedOutput: task.expectedOutput,
      acceptanceCriteria: task.acceptanceCriteria,
      riskClassification: task.riskClassification,
      requiredCapability: task.requiredCapability,
      specialistRole: task.specialistRole,
      maxAttempts: task.maxAttempts,
      completionConditions: task.completionConditions,
      objectiveId,
      planId,
      execution: executionStates.has(task.id) ? {
        status: executionStates.get(task.id).status,
        attempts: executionStates.get(task.id).attempts,
        evidence: executionStates.get(task.id).evidence,
        verification: executionStates.get(task.id).verification || null,
        error: executionStates.get(task.id).error || null,
      } : null,
    }
    const executionState = executionStates.get(task.id)
    const taskStatus = executionState
      ? persistedTaskStatus(executionState.status)
      : 'pending'
    const { rows } = await database.query(
      `INSERT INTO tasks (user_id, project_id, title, description, status, dependencies, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::jsonb) RETURNING id`,
      [
        userId,
        projectId,
        task.description.slice(0, 240),
        task.description,
        taskStatus,
        dependencies,
        JSON.stringify(metadata),
      ],
    )
    createdIds.set(task.id, rows[0].id)
  }
  return graph.tasks.map((task) => createdIds.get(task.id))
}

function persistedTaskStatus(status) {
  if (status === 'verified') return 'completed'
  if (status === 'blocked') return 'blocked'
  if (status === 'interrupted' || status === 'cancelled') return 'cancelled'
  if (status === 'failed' || status === 'uncertain' || status === 'incomplete') return 'failed'
  if (status === 'awaiting_approval' || status === 'authorized' || status === 'executed') return 'running'
  return 'pending'
}
