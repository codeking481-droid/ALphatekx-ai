import { pool } from '../db/pool.js'
import { publishLinkedInPost } from './service.js'

export async function publishDueLinkedInPosts({
  database = pool,
  publish = publishLinkedInPost,
  limit = 10,
} = {}) {
  const client = await database.connect()
  let due
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE scheduled_linkedin_posts
       SET status = 'failed',
           error_message = 'The publishing outcome is uncertain; check LinkedIn before retrying.',
           claimed_at = NULL, updated_at = now()
       WHERE status = 'publishing' AND claimed_at < now() - interval '10 minutes'`,
    )
    const claimed = await client.query(
      `WITH due AS (
         SELECT id FROM scheduled_linkedin_posts
         WHERE status = 'pending' AND scheduled_for <= now()
         ORDER BY scheduled_for, created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE scheduled_linkedin_posts AS post
       SET status = 'publishing', claimed_at = now(), attempts = attempts + 1, updated_at = now()
       FROM due WHERE post.id = due.id
       RETURNING post.id, post.user_id, post.post_text`,
      [Math.max(1, Math.min(50, limit))],
    )
    due = claimed.rows
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  const results = { published: 0, failed: 0 }
  for (const post of due) {
    try {
      const result = await publish({
        userId: post.user_id,
        text: post.post_text,
        database,
      })
      if (result?.posted !== true || typeof result.postId !== 'string' || !result.postId) {
        throw new Error('LinkedIn did not confirm the scheduled post.')
      }
      await database.query(
        `UPDATE scheduled_linkedin_posts
         SET status = 'published', post_id = $2, claimed_at = NULL, error_message = NULL, updated_at = now()
         WHERE id = $1 AND status = 'publishing'`,
        [post.id, result.postId],
      )
      results.published += 1
    } catch (error) {
      await database.query(
        `UPDATE scheduled_linkedin_posts
         SET status = 'failed', error_message = $2, claimed_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'publishing'`,
        [post.id, safeFailure(error)],
      )
      results.failed += 1
    }
  }
  return results
}

function safeFailure(error) {
  const message = typeof error?.message === 'string' ? error.message.trim() : ''
  return (message || 'LinkedIn could not publish the scheduled post.').slice(0, 500)
}
