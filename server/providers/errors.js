export class ProviderError extends Error {
  constructor(message, {
    provider,
    status = 502,
    upstreamStatus,
    retryAfter,
    retryable = false,
    code = 'provider_error',
    cause,
  } = {}) {
    super(message, { cause })
    this.name = 'ProviderError'
    this.provider = provider
    this.status = status
    this.upstreamStatus = upstreamStatus
    this.retryAfter = retryAfter
    this.retryable = retryable
    this.code = code
  }
}

export function providerError(provider, response) {
  const retryable = response.status === 429 || response.status >= 500
  return new ProviderError(
    response.status === 429
      ? 'The selected AI provider is rate limited.'
      : 'The AI provider request failed.',
    {
      provider,
      status: retryable ? 503 : 502,
      upstreamStatus: response.status,
      retryAfter: response.headers.get('retry-after'),
      retryable,
      code: response.status === 429 ? 'rate_limited' : retryable ? 'upstream_unavailable' : 'upstream_rejected',
    },
  )
}

export async function fetchProvider(provider, input, options) {
  try {
    return await fetch(input, options)
  } catch (cause) {
    if (options.signal?.aborted && options.signal.reason?.name === 'AbortError') {
      throw options.signal.reason
    }
    const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError'
    throw new ProviderError(
      timedOut ? 'The AI provider request timed out.' : 'The AI provider could not be reached.',
      {
        provider,
        status: 503,
        retryable: true,
        code: timedOut ? 'timeout' : 'network_error',
        cause,
      },
    )
  }
}

export function providerRequestSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeoutSignal])
  const combined = new AbortController()
  const forward = (source) => {
    if (source.aborted) combined.abort(source.reason)
    else source.addEventListener('abort', () => combined.abort(source.reason), { once: true })
  }
  forward(signal)
  forward(timeoutSignal)
  return combined.signal
}
