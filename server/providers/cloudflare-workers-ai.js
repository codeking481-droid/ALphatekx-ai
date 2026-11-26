import { fetchProvider, ProviderError, providerRequestSignal } from './errors.js'
import { log } from '../observability/logger.js'

const DEFAULT_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
]

export function createCloudflareWorkersAiProvider({
  accountId,
  apiToken,
  timeoutMs,
  models = DEFAULT_MODELS,
}) {
  const configuredModels = models.filter((model) => typeof model === 'string' && model.trim())
  return {
    id: 'workers_ai',
    name: 'Cloudflare Workers AI',
    model: configuredModels[0] || DEFAULT_MODELS[0],
    models: configuredModels,
    isAvailable: Boolean(accountId?.trim() && apiToken?.trim() && configuredModels.length),
    capabilities: {
      textGeneration: Boolean(accountId?.trim() && apiToken?.trim() && configuredModels.length),
      streaming: false,
      structuredOutput: false,
      toolCalling: false,
      imageUnderstanding: false,
      fileProcessing: false,
      embeddings: false,
    },
    async generate({ messages, signal }) {
      if (!accountId?.trim() || !apiToken?.trim()) {
        throw new ProviderError('Cloudflare Workers AI requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.', {
          provider: 'workers_ai',
          status: 503,
          retryable: false,
          code: 'not_configured',
        })
      }

      let lastError
      for (const model of configuredModels) {
        try {
          const response = await fetchProvider('workers_ai', endpoint(accountId, model), {
            method: 'POST',
            signal: providerRequestSignal(signal, timeoutMs),
            headers: {
              Authorization: `Bearer ${apiToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ messages, temperature: 0.3 }),
          })
          if (!response.ok) {
            const detail = await readCloudflareError(response, apiToken)
            throw new ProviderError(`Cloudflare Workers AI model ${model} returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`, {
              provider: 'workers_ai',
              status: response.status >= 500 ? 503 : 502,
              upstreamStatus: response.status,
              retryable: true,
              code: 'cloudflare_workers_ai_failed',
            })
          }
          const data = await response.json()
          const text = typeof data.result?.response === 'string'
            ? data.result.response
            : typeof data.result?.text === 'string'
              ? data.result.text
              : typeof data.response === 'string'
                ? data.response
                : ''
          if (!text.trim()) {
            throw new ProviderError(`Cloudflare Workers AI model ${model} returned no text.`, {
              provider: 'workers_ai',
              status: 502,
              retryable: true,
              code: 'cloudflare_workers_ai_empty_response',
            })
          }
          return {
            text,
            toolCalls: [],
            usage: data.result?.usage || null,
            model,
          }
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error
          lastError = error
          log('warn', 'ai.provider.model_failed', {
            provider: 'workers_ai',
            providerName: 'Cloudflare Workers AI',
            model,
            upstreamStatus: error.upstreamStatus || null,
            code: error.code || null,
            message: redactSecrets(error.message || 'Workers AI model request failed.'),
          })
        }
      }
      throw lastError || new ProviderError('Cloudflare Workers AI did not have a configured model.', {
        provider: 'workers_ai',
        status: 503,
        retryable: false,
      })
    },
    async discoverModels() {
      return [...configuredModels]
    },
  }
}

function endpoint(accountId, model) {
  const encodedModel = model.split('/').map((part) => encodeURIComponent(part).replace(/^%40/i, '@')).join('/')
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${encodedModel}`
}

async function readCloudflareError(response, apiToken) {
  try {
    const body = await response.json()
    const message = Array.isArray(body.errors)
      ? body.errors.map((item) => item.message).filter(Boolean).join('; ')
      : ''
    return message ? redactSecrets(message, [apiToken]).slice(0, 500) : ''
  } catch {
    return ''
  }
}

function redactSecrets(value, secrets = []) {
  return secrets.reduce((message, secret) => (
    secret ? message.split(secret).join('[REDACTED_CLOUDFLARE_API_TOKEN]') : message
  ), String(value))
    .replace(/gsk_[A-Za-z0-9_-]+/gi, '[REDACTED_GROQ_KEY]')
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/gi, '[REDACTED_OPENROUTER_KEY]')
    .replace(/AIzaSy[A-Za-z0-9_-]+/gi, '[REDACTED_GEMINI_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
}
