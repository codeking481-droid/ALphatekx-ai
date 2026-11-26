import { pool } from '../db/pool.js'
import { containsSensitiveMemoryData, normalizeMemoryKind } from '../memory/service.js'

export async function retrieveContext({ userId, conversationId, projectId = null, message = '', limit = 24, database = pool }) {
  let contextProjectId = projectId
  let projectName = ''
  if (conversationId) {
    const conversation = await database.query(
      'SELECT project_id FROM conversations WHERE id = $1 AND user_id = $2',
      [conversationId, userId],
    )
    if (!conversation.rowCount) throw Object.assign(new Error('Conversation not found.'), { status: 404 })
    const conversationProjectId = conversation.rows[0].project_id
    if (projectId && conversationProjectId && projectId !== conversationProjectId) {
      throw Object.assign(new Error('Conversation belongs to a different project.'), { status: 409 })
    }
    contextProjectId = projectId || conversationProjectId
  }
  if (contextProjectId) {
    const project = await database.query(
      'SELECT name FROM projects WHERE id = $1 AND user_id = $2',
      [contextProjectId, userId],
    )
    if (!project.rowCount) throw Object.assign(new Error('Project not found.'), { status: 404 })
    projectName = project.rows[0].name
  }
  const [history, memoryResult] = await Promise.all([
    conversationId
      ? database.query(
          `SELECT m.role, m.content
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE c.id = $1 AND c.user_id = $2
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT $3`,
          [conversationId, userId, limit],
        )
      : { rows: [] },
    database.query(
      `SELECT project_id, kind, content, source FROM memory_records
       WHERE user_id = $1 AND (project_id IS NULL OR project_id = $2)
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY CASE WHEN project_id = $2 THEN 0 WHEN kind = 'preference' THEN 1 ELSE 2 END,
         updated_at DESC LIMIT 100`,
      [userId, contextProjectId],
    ),
  ])
  const messages = history.rows.reverse().map(({ role, content }) => ({ role, content }))
  const memories = selectRelevantMemories(memoryResult.rows, message, projectName, limit)
  return {
    messages,
    pendingQuestion: findPendingQuestion(messages),
    memories,
    globalMemories: memories.filter((item) => item.project_id === null),
    projectMemories: contextProjectId
      ? memories.filter((item) => item.project_id === contextProjectId)
      : [],
    projectId: contextProjectId,
  }
}

function findPendingQuestion(messages) {
  const latest = messages.at(-1)
  if (latest?.role !== 'assistant' || !latest.content.includes('?')) return null
  const previousUserMessage = [...messages].reverse().find(({ role }) => role === 'user')
  if (!previousUserMessage) return null
  return {
    question: latest.content,
    previousUserMessage: previousUserMessage.content,
  }
}

function selectRelevantMemories(memories, message, projectName, limit) {
  const queryTokens = tokenize(`${message} ${projectName}`)
  const ranked = memories
    .filter((memory) => !containsSensitiveMemoryData(memory.content))
    .map((memory, index) => {
      const kind = normalizeMemoryKind(memory.kind)
      const tokens = tokenize(memory.content)
      let score = 0
      for (const token of queryTokens) {
        if (tokens.has(token)) score += token.length > 6 ? 2 : 1
      }
      const isPreference = kind === 'preference' && memory.project_id === null
      const isSelectedProjectMemory = memory.project_id !== null
      const relevant = !queryTokens.size || isPreference || isSelectedProjectMemory || score > 0
      return { memory: { ...memory, kind }, index, score, isPreference, relevant }
    })
    .filter(({ relevant }) => relevant)
    .sort((left, right) => Number(right.isPreference) - Number(left.isPreference) ||
      right.score - left.score || left.index - right.index)
  return ranked.slice(0, Math.min(Math.max(limit, 1), 24)).map(({ memory }) => memory)
}

function tokenize(value) {
  const ignored = new Set(['about', 'after', 'before', 'from', 'have', 'into', 'that', 'them', 'there', 'these', 'they', 'this', 'what', 'when', 'where', 'which', 'with', 'would', 'your'])
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9+.-]{2,}/g)?.filter((token) => !ignored.has(token)) || [])
}
