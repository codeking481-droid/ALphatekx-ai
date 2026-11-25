import { ProviderError, fetchProvider, providerRequestSignal } from './errors.js'

export function createCloudflareWorkerProvider({ id, name, url, timeoutMs }) {
  return {
    id,
    name,
    model: null,
    capabilities: {
      textGeneration: Boolean(url),
      streaming: false,
      structuredOutput: false,
      toolCalling: false,
      imageUnderstanding: false,
      fileProcessing: false,
      embeddings: false,
    },
    isAvailable: Boolean(url),
    async generate({ messages, signal }) {
      if (!url) throw new ProviderError(`${name} is not configured.`, { provider: id, status: 503 })

      const response = await fetchProvider(id, url, {
        method: 'POST',
        signal: providerRequestSignal(signal, timeoutMs),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      })
      if (!response.ok) {
        throw new ProviderError('The AI worker request failed.', {
          provider: id,
          status: response.status >= 500 ? 503 : 502,
          upstreamStatus: response.status,
          retryable: true,
          code: 'worker_request_failed',
        })
      }

      let data
      try {
        data = await response.json()
      } catch (cause) {
        throw new ProviderError('The AI worker returned an invalid response.', {
          provider: id,
          retryable: true,
          code: 'worker_invalid_response',
          cause,
        })
      }

      const text = typeof data.response === 'string'
        ? data.response
        : typeof data.text === 'string'
          ? data.text
          : data.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) {
        throw new ProviderError('The AI worker response did not contain text.', {
          provider: id,
          retryable: true,
          code: 'worker_missing_text',
        })
      }

      return { text, toolCalls: [], usage: data.usage || null, model: data.model || null }
    },
    async discoverModels() {
      return []
    },
  }
}
