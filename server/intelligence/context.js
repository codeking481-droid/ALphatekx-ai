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
  const [history, pendingApprovalResult, memoryResult] = await Promise.all([
    conversationId
      ? database.query(
          `SELECT m.id, m.role, m.content, m.metadata
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           WHERE c.id = $1 AND c.user_id = $2
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT $3`,
          [conversationId, userId, limit],
        )
      : { rows: [] },
    conversationId
      ? database.query(
          `SELECT a.id AS approval_id, e.input AS tool_input,
                  r.input->'continuation' AS continuation
           FROM jobs j
           JOIN approval_requests a ON a.id = j.approval_id AND a.user_id = j.user_id
           JOIN tool_executions e ON e.id = a.tool_execution_id AND e.user_id = a.user_id
           JOIN agent_runs r ON r.id = e.agent_run_id AND r.user_id = a.user_id
           WHERE j.conversation_id = $1 AND j.user_id = $2
             AND j.status = 'waiting_approval' AND a.status = 'pending'
             AND a.expires_at > now() AND e.tool_id = 'linkedin_post'
           ORDER BY a.created_at DESC LIMIT 1`,
          [conversationId, userId],
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
  const messages = history.rows.reverse().map(({ id, role, content, metadata }) => ({
    id,
    role,
    content,
    metadata: parseMetadata(metadata),
  }))
  const persistedTask = findActiveTask(messages)
  const activeTask = persistedTask.found
    ? persistedTask.task
    : activeTaskFromApproval(pendingApprovalResult.rows[0], messages)
  const memories = selectRelevantMemories(memoryResult.rows, message, projectName, limit)
  return {
    messages,
    pendingQuestion: findPendingQuestion(messages),
    activeTask,
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
    ...(latest.id ? { messageId: latest.id } : {}),
  }
}

function findActiveTask(messages) {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant' || !Object.hasOwn(message.metadata || {}, 'activeTask')) continue
    const activeTask = message.metadata.activeTask
    return {
      found: true,
      task: activeTask && typeof activeTask === 'object' && !Array.isArray(activeTask) ? activeTask : null,
    }
  }
  return { found: false, task: null }
}

function parseMetadata(metadata) {
  if (typeof metadata === 'string') {
    return JSON.parse(metadata)
  }
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
}

function activeTaskFromApproval(row, messages) {
  if (!row) return null
  const toolInput = parseMetadata(row.tool_input)
  const continuation = parseMetadata(row.continuation)
  if (toolInput.schedule?.mode !== 'recurring') return null
  const originalRequest = [...(Array.isArray(continuation.contextMessages) ? continuation.contextMessages : [])]
    .reverse()
    .find((message) =>
      message.role === 'user' &&
      /\b(?:post|publish|linkedin)\b/i.test(message.content || '') &&
      /\b(?:every\s+day|daily|weekly|every\s+week|for\s+(?:one|a|\d+)\s+weeks?|for\s+\d+\s+days?|posts?\s+total)\b/i.test(message.content || ''))
    ?.content || continuation.request || ''
  const questionMessage = [...messages].reverse().find((message) =>
    message.role === 'assistant' &&
    /\bsame text\b[\s\S]*\bdifferent versions\b/i.test(message.content || ''))
  const questionIndex = questionMessage ? messages.indexOf(questionMessage) : -1
  const answerMessage = questionIndex >= 0
    ? messages.slice(questionIndex + 1).find((message) => message.role === 'user')
    : null
  const answerMatch = /^\s*\d+\.\s*([\s\S]+?\?):\s*([\s\S]+)$/.exec(answerMessage?.content || '')
  const answers = answerMatch ? [{
    question_id: questionMessage.id ? `${questionMessage.id}:q1` : 'recovered-question:q1',
    question_text: answerMatch[1].trim(),
    option_clicked: answerMatch[2].trim(),
    answer_text: answerMatch[2].trim(),
  }] : []
  return {
    version: 1,
    kind: 'linkedin_recurring',
    status: 'awaiting_approval',
    originalRequest,
    postText: toolInput.text || '',
    toolInput,
    schedule: toolInput.schedule,
    approvalId: row.approval_id,
    skill: continuation.skill || null,
    answers,
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
