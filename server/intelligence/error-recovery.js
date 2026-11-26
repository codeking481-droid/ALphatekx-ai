import { invokeFallbackChain } from '../providers/fallback-chain.js'

export async function invokeWithProviderFallback(registry, provider, request, telemetry = {}) {
  if (request.signal?.aborted || telemetry.signal?.aborted) {
    throw (request.signal || telemetry.signal).reason || new Error('Model request was cancelled.')
  }
  return invokeFallbackChain(registry, provider, request.messages, { ...request, ...telemetry })
}
