import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { pool } from '../db/pool.js'
import { config } from '../config.js'

export async function listConversations({ userId, search = '', cursor = null, limit = 30, database = pool }) {
  const parsedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100)
  const values = [userId]
  const clauses = ['user_id = $1']
  if (search) {
    values.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`)
    clauses.push(`(title ILIKE $${values.length} ESCAPE '\\' OR last_message ILIKE $${values.length} ESCAPE '\\')`)
  }
  if (cursor) {
    values.push(cursor.updatedAt, cursor.id)
    clauses.push(`(updated_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`)
  }
  values.push(parsedLimit + 1)
  const { rows } = await database.query(
    `SELECT id, title, last_message, message_count, created_at, updated_at
     FROM conversations WHERE ${clauses.join(' AND ')}
     ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`,
    values,
  )
  const hasMore = rows.length > parsedLimit
  const items = rows.slice(0, parsedLimit).map(toClientConversation)
  const last = items.at(-1)
  return {
    items,
    next_cursor: hasMore && last ? Buffer.from(JSON.stringify({ updatedAt: last.updated_date, id: last.id })).toString('base64url') : null,
  }
}

export async function getConversation({ userId, conversationId, database = pool }) {
  const { rows } = await database.query(
    `SELECT id, title, last_message, message_count, created_at, updated_at
     FROM conversations WHERE id = $1 AND user_id = $2`,
    [conversationId, userId],
  )
  return rows[0] ? toClientConversation(rows[0]) : null
}

export async function getMessages({ userId, conversationId, limit = 200, database = pool }) {
  const { rows } = await database.query(
    `SELECT m.id, m.role, m.content, m.metadata, m.created_at
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.id = $1 AND c.user_id = $2 AND m.role IN ('user', 'assistant')
     ORDER BY m.created_at ASC, m.id ASC LIMIT $3`,
    [conversationId, userId, Math.min(Math.max(Number(limit) || 200, 1), 500)],
  )
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    ...(Object.hasOwn(row.metadata || {}, 'skill') ? { skill: row.metadata.skill } : {}),
    ...(Array.isArray(row.metadata?.memoriesUsed) ? { memoriesUsed: row.metadata.memoriesUsed } : {}),
    ...(Array.isArray(row.metadata?.clarificationAnswers) ? { clarificationAnswers: row.metadata.clarificationAnswers } : {}),
    attachments: row.metadata?.attachments || [],
    created_date: row.created_at,
  }))
}

export async function deleteConversation({ userId, conversationId, database = pool }) {
  const client = await database.connect()
  let storageKeys = []
  try {
    await client.query('BEGIN')
    const attachments = await client.query(
      `SELECT a.storage_key FROM attachments a
       JOIN conversations c ON c.id = a.conversation_id
       WHERE c.id = $1 AND c.user_id = $2`,
      [conversationId, userId],
    )
    storageKeys = attachments.rows.map(({ storage_key }) => storage_key)
    const result = await client.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, userId])
    await client.query('COMMIT')
    if (!result.rowCount) return false
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  await Promise.all(storageKeys.map(async (storageKey) => {
    if (!/^[a-f0-9-]{36}$/i.test(storageKey)) throw new Error('Stored attachment key is invalid.')
    await unlink(path.join(config.uploadDir, storageKey)).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }))
  return true
}

function toClientConversation(row) {
  return {
    id: row.id,
    title: row.title,
    last_message: row.last_message,
    message_count: row.message_count,
    created_date: row.created_at,
    updated_date: row.updated_at,
  }
}
