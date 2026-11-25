import { ProviderError } from '../providers/errors.js'
import { invokeModel } from './model-invocation.js'
import { selectProvider } from './provider-selector.js'

export async function invokeWithProviderFallback(registry, provider, request, telemetry = {}) {
  if (request.signal?.aborted || telemetry.signal?.aborted) {
    throw (request.signal || telemetry.signal).reason || new Error('Model request was cancelled.')
  }
  try {
    return {
      provider,
      result: await invokeModel(provider, request.messages, { ...request, ...telemetry }),
      fallbackUsed: false,
    }
  } catch (error) {
    if (request.signal?.aborted || telemetry.signal?.aborted) {
      throw (request.signal || telemetry.signal).reason || error
    }
    if (!(error instanceof ProviderError) || !error.retryable) throw error
    const capability = request.capability || 'textGeneration'
    const hasFallback = registry.list().some((candidate) => (
      candidate.id !== provider.id &&
      candidate.available &&
      candidate.capabilities?.[capability]
    ))
    if (!hasFallback) throw error
    const fallback = selectProvider(registry, {
      preferred: provider.id === 'worker1' ? 'worker2' : undefined,
      exclude: [provider.id],
      capability,
    })
    const fallbackRequest = request.jsonSchema && !fallback.capabilities?.structuredOutput
      ? { ...request, jsonSchema: undefined }
      : request
    return {
      provider: fallback,
      result: await invokeModel(fallback, fallbackRequest.messages, { ...fallbackRequest, ...telemetry }),
      fallbackUsed: true,
    }
  }
}
