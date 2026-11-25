import { pool } from '../db/pool.js'
import { log } from '../observability/logger.js'

export async function invokeModel(provider, messages, {
  userId = null,
  requestId = null,
  database = pool,
  capability = 'text_generation',
  ...options
} = {}) {
  const startedAt = Date.now()
  let result
  try {
    result = await provider.generate({ messages, ...options })
  } catch (error) {
    await recordUsageSafely({
      userId, requestId, providerId: provider.id, modelId: provider.model, capability,
      usage: null, latencyMs: Date.now() - startedAt, success: false,
      errorClass: error.code || error.name || 'Error', database,
    })
    throw error
  }
  await recordUsageSafely({
    userId, requestId, providerId: provider.id, modelId: result?.model || provider.model, capability,
    usage: result?.usage, latencyMs: Date.now() - startedAt, success: true, database,
  })
  return result
}

async function recordUsageSafely(usageEvent) {
  try {
    await recordUsage(usageEvent)
  } catch (error) {
    log('error', 'ai.usage.recording_failed', {
      requestId: usageEvent.requestId,
      providerId: usageEvent.providerId,
      error: { name: error.name || 'Error', message: error.message || 'Usage event could not be stored.' },
    })
  }
}

async function recordUsage({
  userId, requestId, providerId, modelId, capability, usage, latencyMs, success, errorClass = null, database,
}) {
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokenCount ?? null
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? usage?.candidatesTokenCount ?? null
  await database.query(
    `INSERT INTO ai_usage_events
       (user_id, request_id, provider_id, model_id, capability, input_tokens, output_tokens, latency_ms, success, error_class)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [userId, requestId, providerId, modelId || null, capability, inputTokens, outputTokens, latencyMs, success, errorClass],
  )
}
