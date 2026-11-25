import { createReadStream } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { config } from '../config.js'

export const MAX_FILE_BYTES = 20 * 1024 * 1024
const textMimeTypes = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json'])

export async function saveUpload({ userId, file, database = pool }) {
  const id = randomUUID()
  await mkdir(config.uploadDir, { recursive: true })
  const filePath = path.join(config.uploadDir, id)
  await writeFile(filePath, file.buffer, { flag: 'wx' })
  try {
    await database.query(
      `INSERT INTO attachments (id, user_id, original_name, mime_type, size_bytes, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, path.basename(file.originalname || 'attachment').slice(0, 255), file.mimetype || 'application/octet-stream', file.size, id],
    )
  } catch (error) {
    await unlink(filePath).catch(() => {})
    throw error
  }
  return { id, name: path.basename(file.originalname || 'attachment').slice(0, 255), url: `/api/files/${id}`, type: file.mimetype, size: file.size }
}

export async function getOwnedFile({ userId, fileId, database = pool }) {
  const { rows } = await database.query(
    'SELECT id, original_name, mime_type, size_bytes, storage_key FROM attachments WHERE id = $1 AND user_id = $2',
    [fileId, userId],
  )
  if (!rows[0]) return null
  return { ...rows[0], stream: createReadStream(path.join(config.uploadDir, rows[0].storage_key)) }
}

export async function getAttachmentText({ userId, url, database = pool }) {
  const match = /^\/api\/files\/([a-f0-9-]{36})$/i.exec(url)
  if (!match) throw Object.assign(new Error('Attachment URL is invalid.'), { status: 400 })
  const { rows } = await database.query(
    'SELECT original_name, mime_type, storage_key FROM attachments WHERE id = $1 AND user_id = $2',
    [match[1], userId],
  )
  if (!rows[0]) throw Object.assign(new Error('Attachment was not found.'), { status: 404 })
  if (!textMimeTypes.has(rows[0].mime_type)) {
    throw Object.assign(new Error(`The attached file "${rows[0].original_name}" is uploaded, but this configured AI path currently processes text, Markdown, CSV, and JSON only.`), { status: 415 })
  }
  const chunks = []
  for await (const chunk of createReadStream(path.join(config.uploadDir, rows[0].storage_key), { encoding: 'utf8' })) chunks.push(chunk)
  return { name: rows[0].original_name, content: chunks.join('').slice(0, 50_000) }
}
