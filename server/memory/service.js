import { pool } from '../db/pool.js'

const MEMORY_KINDS = new Set(['preference', 'conversation_context', 'project_context', 'task_history', 'agent_history'])
const MEMORY_TYPES = new Set(['fact', 'preference', 'project', 'lesson-learned', ...MEMORY_KINDS])

export async function createMemory({ userId, kind, content, source, projectId = null, database = pool }) {
  validateMemory(kind, content)
  if (typeof source !== 'string' || !source.trim() || source.length > 240) {
    throw Object.assign(new Error('A memory source of up to 240 characters is required.'), { status: 400 })
  }
  if (projectId) {
    const project = await database.query('SELECT 1 FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId])
    if (!project.rowCount) throw new Error('Project not found.')
  }
  const { rows } = await database.query(
    `INSERT INTO memory_records (user_id, kind, content, source, project_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, kind, content, source, project_id, created_at`,
    [userId, kind, content.trim(), source, projectId],
  )
  return rows[0]
}

export async function updateMemory({ userId, memoryId, kind, content, projectId, database = pool }) {
  const { rows: existing } = await database.query(
    'SELECT kind, content, project_id FROM memory_records WHERE id = $1 AND user_id = $2',
    [memoryId, userId],
  )
  if (!existing[0]) return null
  const nextKind = kind === undefined ? existing[0].kind : kind
  const nextContent = content === undefined ? existing[0].content : content
  const nextProjectId = projectId === undefined ? existing[0].project_id : projectId
  validateMemory(nextKind, nextContent)
  if (nextProjectId) {
    const project = await database.query('SELECT 1 FROM projects WHERE id = $1 AND user_id = $2', [nextProjectId, userId])
    if (!project.rowCount) throw Object.assign(new Error('Project not found.'), { status: 404 })
  }
  const { rows } = await database.query(
    `UPDATE memory_records
     SET kind = $3, content = $4, project_id = $5, updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING id, kind, content, source, project_id, created_at, updated_at`,
    [memoryId, userId, nextKind, nextContent.trim(), nextProjectId],
  )
  return rows[0] || null
}

export async function listMemories(userId, database = pool) {
  const { rows } = await database.query(
    'SELECT id, kind, content, source, project_id, created_at, updated_at FROM memory_records WHERE user_id = $1 ORDER BY updated_at DESC',
    [userId],
  )
  return rows
}

export async function deleteMemory(userId, memoryId, database = pool) {
  const result = await database.query('DELETE FROM memory_records WHERE id = $1 AND user_id = $2', [memoryId, userId])
  return result.rowCount > 0
}

export async function deleteAllMemories(userId, database = pool) {
  const result = await database.query('DELETE FROM memory_records WHERE user_id = $1', [userId])
  return result.rowCount
}

export function normalizeMemoryKind(kind) {
  if (kind === 'conversation_context') return 'fact'
  if (kind === 'project_context') return 'project'
  if (kind === 'task_history' || kind === 'agent_history') return 'lesson-learned'
  return kind
}

export function validateMemory(kind, content) {
  if (!MEMORY_TYPES.has(kind)) throw Object.assign(new Error('Unsupported memory type.'), { status: 400 })
  if (typeof content !== 'string' || !content.trim() || content.length > 12_000) {
    throw Object.assign(new Error('Memory content must be between 1 and 12000 characters.'), { status: 400 })
  }
  if (containsSensitiveMemoryData(content)) {
    throw Object.assign(new Error('Memory cannot contain secrets or sensitive personal data.'), { status: 400 })
  }
}

export function containsSensitiveMemoryData(value) {
  return typeof value === 'string' && (
    /\b(?:password|passphrase|api[ _-]?key|secret|access token|refresh token|credential|private key|authorization header)\b/i.test(value) ||
    /\b(?:social security|ssn|credit card|cvv|bank account|passport number|medical diagnosis|prescription)\b/i.test(value) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value) ||
    /\b(?:my|our) (?:phone|mobile|telephone|email|home address|street address|date of birth|birthday|bank account|passport|health|medical)\b/i.test(value) ||
    /\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/i.test(value) ||
    /\b\d{3}[- ]\d{2}[- ]\d{4}\b/.test(value) ||
    /\bI (?:live|reside) (?:in|at)\b/i.test(value)
  )
}
