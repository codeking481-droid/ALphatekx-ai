import { log } from '../observability/logger.js'
import { ProviderError } from './errors.js'
import { invokeModel } from '../intelligence/model-invocation.js'

export const FALLBACK_PROVIDER_IDS = ['openrouter', 'gemini', 'worker1']

export function formatFallbackTrace(trace) {
  if (!trace?.length) return ''
  const failures = trace.filter((item) => item.status === 'failed')
  if (!failures.length) return ''
  const uniqueFailures = [...new Map(failures.map((item) => [item.provider, item])).values()]
  const providerNames = uniqueFailures.map((item) => {
    const status = item.upstreamStatus ? ` ${item.upstreamStatus}` : ''
    return `${item.name} failed${status}`
  })
  const used = trace.at(-1)
  const lead = providerNames.join(', ')
  if (used.status === 'local') return `Main AI was down (${lead}). I used the local fallback.`
  return `${lead}; tried ${used.name} fallback.`
}

export async function invokeFallbackChain(registry, preferredProvider, messages, options = {}) {
  if (options.signal?.aborted) {
    throw options.signal.reason || new Error('Model request was cancelled.')
  }

  const trace = []
  const ordered = []
  for (const id of FALLBACK_PROVIDER_IDS) {
    const provider = registry.get(id)
    if (provider && !ordered.some((item) => item.id === provider.id)) ordered.push(provider)
  }
  if (preferredProvider && !ordered.some((item) => item.id === preferredProvider.id)) ordered.push(preferredProvider)
  for (const item of registry.list()) {
    if (item.available === false) continue
    const provider = registry.get(item.id)
    if (provider && !ordered.some((candidate) => candidate.id === provider.id)) ordered.push(provider)
  }

  for (const provider of ordered) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const startedAt = Date.now()
      try {
        const signal = shorterRequestSignal(options.signal, 30_000)
        const result = await invokeModel(provider, attempt === 1 ? messages : shortenMessages(messages), {
          ...options,
          signal,
          capability: options.capability || 'textGeneration',
        })
        if (options.jsonSchema) {
          try {
            JSON.parse(result.text)
          } catch (cause) {
            if (attempt === 1) {
              throw new ProviderError('The model returned invalid JSON.', {
                provider: provider.id,
                status: 502,
                retryable: true,
                code: 'invalid_json',
                upstreamStatus: null,
                cause,
              })
            }
            throw new ProviderError('The model returned invalid JSON twice.', {
              provider: provider.id,
              status: 502,
              retryable: true,
              code: 'invalid_json',
              upstreamStatus: null,
            })
          }
        }
        trace.push({ name: provider.name, provider: provider.id, status: 'used', latencyMs: Date.now() - startedAt })
        return {
          provider,
          result,
          fallbackUsed: trace.some((item) => item.status === 'failed'),
          fallbackTrace: trace,
        }
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason || error
        if (error instanceof ProviderError && error.retryable === false) throw error
        const upstreamStatus = error.upstreamStatus || (error.status >= 400 ? error.status : null)
        if (error.code === 'invalid_json' && attempt === 1) {
          log('warn', 'ai.provider.invalid_json', {
            provider: provider.id,
            providerName: provider.name,
            upstreamStatus,
            code: error.code,
            message: 'Invalid JSON returned; retrying with a shorter prompt.',
          })
          continue
        }
        trace.push({
          name: provider.name,
          provider: provider.id,
          status: 'failed',
          upstreamStatus,
          attempt,
          latencyMs: Date.now() - startedAt,
        })
        log('warn', 'ai.provider.failed', {
          provider: provider.id,
          providerName: provider.name,
          upstreamStatus,
          code: error.code || null,
          message: redactSecrets(error.message || 'Provider request failed.'),
        })
        if (error.retryable !== false && attempt === 1) {
          continue
        }
        break
      }
    }
  }

  trace.push({ name: 'Local fallback', provider: 'local-fallback', status: 'local', upstreamStatus: null })
  log('warn', 'ai.local_fallback.used', {
    provider: 'local-fallback',
    providersAttempted: trace.filter((item) => item.status === 'failed').map((item) => item.provider),
  })
  return {
    provider: {
      id: 'local-fallback',
      name: 'Local fallback',
      model: null,
      isAvailable: true,
      capabilities: { textGeneration: true, structuredOutput: false, toolCalling: false },
    },
    result: {
      text: 'Main AI was down, I used fallback. I can still create local deterministic artifacts and show the requested draft, but some model-generated analysis may be unavailable.',
      toolCalls: [],
      usage: null,
      model: null,
    },
    fallbackUsed: true,
    fallbackTrace: trace,
  }
}

function shorterRequestSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeoutSignal])
  const controller = new AbortController()
  for (const source of [signal, timeoutSignal]) {
    source.addEventListener('abort', () => controller.abort(source.reason), { once: true })
  }
  return controller.signal
}

function shortenMessages(messages) {
  const shortened = messages.map((message) => ({
    ...message,
    content: typeof message.content === 'string'
      ? message.content.slice(0, 12_000)
      : message.content,
  }))
  const jsonHint = {
    role: 'system',
    content: 'Retry with a shorter prompt. Return ONLY valid JSON, no markdown, no explanation.',
  }
  return [jsonHint, ...shortened]
}

function redactSecrets(value) {
  return String(value)
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/gi, '[REDACTED_OPENROUTER_KEY]')
    .replace(/AIzaSy[A-Za-z0-9_-]+/gi, '[REDACTED_GEMINI_KEY]')
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
}
