import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { encryptLinkedInToken } from './crypto.js'
import { createLinkedInPost, replyToLinkedInComment, scheduleLinkedInPosts, validatePostSchedule } from './service.js'

const userId = 'linkedin-test-user'
const encryptionKey = randomBytes(32).toString('base64')
const env = {
  LINKEDIN_CLIENT_ID: 'test-client-id',
  LINKEDIN_CLIENT_SECRET: 'test-client-secret',
  LINKEDIN_REDIRECT_URI: 'https://alphatekx-ai.pages.dev/api/linkedin/callback',
  LINKEDIN_API_VERSION: '202611',
  LINKEDIN_TOKEN_ENCRYPTION_KEY: encryptionKey,
}

function createDatabase() {
  const approvals = new Map()
  const accessToken = 'test-access-token'
  const connection = {
    linkedin_id: 'linkedin-person-1',
    token_encrypted: encryptLinkedInToken(JSON.stringify({ accessToken }), encryptionKey),
    expires_at: new Date(Date.now() + 60_000),
  }
  return {
    async query(sql, values = []) {
      if (sql.startsWith('DELETE FROM linkedin_action_approvals WHERE expires_at')) {
        return { rowCount: 0, rows: [] }
      }
      if (sql.startsWith('INSERT INTO linkedin_action_approvals')) {
        approvals.set(values[0], {
          userId: values[1],
          action: values[2],
          payloadHash: values[3],
        })
        return { rowCount: 1, rows: [] }
      }
      if (sql.includes('DELETE FROM linkedin_action_approvals') && sql.includes('RETURNING user_id')) {
        const approval = approvals.get(values[0])
        if (!approval || approval.userId !== values[1] ||
          approval.action !== values[2] || approval.payloadHash !== values[3]) {
          return { rowCount: 0, rows: [] }
        }
        approvals.delete(values[0])
        return { rowCount: 1, rows: [{ user_id: userId }] }
      }
      if (sql.includes('FROM linkedin_connections')) {
        return { rowCount: 1, rows: [connection] }
      }
      throw new Error(`Unexpected SQL in test: ${sql}`)
    },
  }
}

test('LinkedIn publishing requires one-use approval bound to the exact previewed text', async () => {
  const database = createDatabase()
  const preview = await createLinkedInPost({
    userId,
    text: 'AlphaTekx is live.',
    approved: false,
    database,
    env,
  })
  assert.equal(preview.preview, true)
  assert.match(preview.approvalId, /^[A-Za-z0-9_-]{43}$/)

  let upstreamCalls = 0
  const fetchImpl = async (_url, options) => {
    upstreamCalls += 1
    assert.equal(options.headers.Authorization, 'Bearer test-access-token')
    assert.equal(JSON.parse(options.body).commentary, 'AlphaTekx is live.')
    return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:post-1' } })
  }

  await assert.rejects(
    createLinkedInPost({
      userId,
      text: 'Changed after preview',
      approved: true,
      approvalId: preview.approvalId,
      database,
      env,
      fetchImpl,
    }),
    { status: 409 },
  )
  assert.equal(upstreamCalls, 0)

  const published = await createLinkedInPost({
    userId,
    text: preview.text,
    approved: true,
    approvalId: preview.approvalId,
    database,
    env,
    fetchImpl,
  })
  assert.equal(published.posted, true)
  assert.equal(published.postId, 'urn:li:share:post-1')
  assert.equal(upstreamCalls, 1)

  await assert.rejects(
    createLinkedInPost({
      userId,
      text: preview.text,
      approved: true,
      approvalId: preview.approvalId,
      database,
      env,
      fetchImpl,
    }),
    { status: 409 },
  )
  assert.equal(upstreamCalls, 1)
})

test('LinkedIn reply cannot be published with a forged approval boolean', async () => {
  let upstreamCalls = 0
  await assert.rejects(
    replyToLinkedInComment({
      userId,
      commentId: 'urn:li:comment:(urn:li:activity:123,456)',
      text: 'Thanks for sharing.',
      approved: true,
      database: createDatabase(),
      env,
      fetchImpl: async () => {
        upstreamCalls += 1
        return new Response(null, { status: 201 })
      },
    }),
    { status: 403 },
  )
  assert.equal(upstreamCalls, 0)
})

test('LinkedIn schedule validation requires explicit recurring text reuse or distinct drafts', () => {
  assert.throws(() => validatePostSchedule({
    mode: 'scheduled',
    scheduledAt: '2026-03-10T17:00:00.000Z',
    timezone: 'Mars/Olympus',
  }), /timezone is invalid/)
  assert.throws(() => validatePostSchedule({
    mode: 'recurring',
    scheduledAt: '2026-03-10T17:00:00.000Z',
    timezone: 'UTC',
    count: 7,
    intervalMinutes: 1440,
    sameText: false,
  }), /one text for each date/)

  assert.deepEqual(validatePostSchedule({
    mode: 'recurring',
    scheduledAt: '2026-03-10T17:00:00.000Z',
    timezone: 'America/Los_Angeles',
    count: 7,
    intervalMinutes: 1440,
    sameText: true,
  }), {
    mode: 'recurring',
    scheduledAt: '2026-03-10T17:00:00.000Z',
    timezone: 'America/Los_Angeles',
    count: 7,
    intervalMinutes: 1440,
    sameText: true,
  })
})

test('approved scheduled posts are queued without calling LinkedIn immediately', async () => {
  const database = createDatabase()
  const inserts = []
  database.connect = async () => ({
    async query(sql, values = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] }
      if (sql.includes('INSERT INTO scheduled_linkedin_posts')) {
        inserts.push(values)
        return { rows: [{ id: `scheduled-${inserts.length}`, scheduled_for: values[4] }] }
      }
      throw new Error(`Unexpected client SQL: ${sql}`)
    },
    release() {},
  })
  let upstreamCalls = 0
  const result = await scheduleLinkedInPosts({
    userId,
    text: 'Biz is live.',
    schedule: {
      mode: 'recurring',
      scheduledAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      timezone: 'UTC',
      count: 3,
      intervalMinutes: 1440,
      sameText: true,
    },
    database,
    env,
    fetchImpl: async () => { upstreamCalls += 1 },
  })

  assert.equal(result.scheduled, true)
  assert.equal(result.count, 3)
  assert.equal(inserts.length, 3)
  assert.equal(upstreamCalls, 0)
})

test('LinkedIn scheduled posts keep the schedule bound to approval and do not publish immediately', async () => {
  const database = createDatabase()
  const inserts = []
  database.connect = async () => ({
    async query(sql, values = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] }
      if (sql.includes('INSERT INTO scheduled_linkedin_posts')) {
        inserts.push(values)
        return { rows: [{ id: 'scheduled-1', scheduled_for: values[4] }] }
      }
      throw new Error(`Unexpected client SQL: ${sql}`)
    },
    release() {},
  })
  const schedule = {
    mode: 'scheduled',
    scheduledAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    timezone: 'UTC',
  }
  const preview = await createLinkedInPost({
    userId,
    text: 'Biz is launching.',
    schedule,
    approved: false,
    database,
    env,
  })
  assert.equal(preview.preview, true)

  await assert.rejects(createLinkedInPost({
    userId,
    text: 'Biz is launching.',
    schedule: { ...schedule, scheduledAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString() },
    approvalId: preview.approvalId,
    approved: true,
    database,
    env,
  }), { status: 409 })
  assert.equal(inserts.length, 0)

  const result = await createLinkedInPost({
    userId,
    text: preview.text,
    schedule,
    approvalId: preview.approvalId,
    approved: true,
    database,
    env,
  })
  assert.equal(result.scheduled, true)
  assert.equal(result.count, 1)
  assert.equal(inserts.length, 1)
})
