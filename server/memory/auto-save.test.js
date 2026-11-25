import test from 'node:test'
import assert from 'node:assert/strict'
import { extractDurableMemories, saveAutomaticMemories } from './auto-save.js'

test('durable preference, project, and business facts are extracted from a chat message', () => {
  assert.deepEqual(
    extractDurableMemories('I like simple English. My business is SkinSnap, I sell in UK.'),
    [
      { kind: 'preference', content: 'Likes simple English' },
      { kind: 'project', content: 'Business: SkinSnap' },
      { kind: 'fact', content: 'Sells in UK' },
    ],
  )
})

test('passwords, credentials, and sensitive personal data are never extracted', () => {
  assert.deepEqual(extractDurableMemories('My password is hunter2. My API key is abc123.'), [])
  assert.deepEqual(extractDurableMemories('My email is alex@example.com.'), [])
})

test('lessons about what worked or failed are stored as lessons', () => {
  assert.deepEqual(extractDurableMemories('What worked was using short demos. I learned that follow-up matters.'), [
    { kind: 'lesson-learned', content: 'Worked: using short demos' },
    { kind: 'lesson-learned', content: 'Learned: follow-up matters' },
  ])
})

test('automatic memory saves are idempotent and keep preferences global', async () => {
  const records = []
  const auditEvents = []
  const database = {
    async query(sql, values = []) {
      if (sql.includes('SELECT id FROM memory_records')) {
        const found = records.some((item) =>
          item.userId === values[0] && item.projectId === values[1] &&
          item.kind === values[2] && item.content.toLowerCase() === values[3].toLowerCase())
        return { rowCount: found ? 1 : 0, rows: found ? [{ id: 'existing' }] : [] }
      }
      if (sql.includes('INSERT INTO memory_records')) {
        const row = {
          id: `memory-${records.length + 1}`,
          userId: values[0],
          kind: values[1],
          content: values[2],
          projectId: values[3],
        }
        records.push(row)
        return { rowCount: 1, rows: [row] }
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        auditEvents.push(values)
        return { rowCount: 1, rows: [] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    },
  }
  const input = {
    userId: 'user-1',
    projectId: 'project-1',
    message: 'I like simple English. My business is SkinSnap, I sell in UK.',
    database,
  }
  const first = await saveAutomaticMemories(input)
  const second = await saveAutomaticMemories(input)

  assert.equal(first.length, 3)
  assert.equal(second.length, 0)
  assert.equal(records.find(({ kind }) => kind === 'preference').projectId, null)
  assert.equal(records.filter(({ projectId }) => projectId === 'project-1').length, 2)
  assert.equal(auditEvents.length, 1)
})
