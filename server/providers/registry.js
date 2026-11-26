import { config } from '../config.js'
import { createAnthropicProvider } from './anthropic.js'
import { createGeminiProvider } from './gemini.js'
import { assertProviderContract } from './interface.js'
import { createOpenAICompatibleProvider } from './openai-compatible.js'
import { createCloudflareWorkerProvider } from './cloudflare-worker.js'

const compatibleProviders = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', key: 'DEEPSEEK_API_KEY' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', key: 'MISTRAL_API_KEY' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY' },
  { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', key: 'XAI_API_KEY' },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    key: 'OPENROUTER_API_KEY',
    headers: { 'HTTP-Referer': process.env.WEB_ORIGIN || 'http://localhost:5173', 'X-Title': 'Biz' },
    supports: { textGeneration: true, streaming: true, toolCalling: true, structuredOutput: true },
  },
]

export function createProviderRegistry(env = process.env) {
  const providers = new Map()
  const metrics = new Map()
  const timeoutMs = config.aiRequestTimeoutMs

  for (const definition of compatibleProviders) {
    metrics.set(definition.id, providerMetrics(definition.id, env))
    providers.set(definition.id, createOpenAICompatibleProvider({
      ...definition,
      apiKey: env[definition.key],
      model: definition.id === 'openrouter'
        ? env.OPENROUTER_MODEL || env.AI_MODEL_OPENROUTER
        : env[`AI_MODEL_${definition.id.toUpperCase()}`],
      timeoutMs,
      extraHeaders: definition.headers,
      supports: definition.supports,
    }))
  }
  for (const definition of [
    { id: 'worker1', name: 'AI Worker 1', urlEnv: 'AI_PROVIDER_URL_1' },
    { id: 'worker2', name: 'AI Worker 2', urlEnv: 'AI_PROVIDER_URL_2' },
  ]) {
    metrics.set(definition.id, providerMetrics(definition.id, env))
    providers.set(definition.id, createCloudflareWorkerProvider({
      ...definition,
      url: workerUrl(env[definition.urlEnv], definition.urlEnv),
      timeoutMs,
    }))
  }
  providers.set('anthropic', createAnthropicProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.AI_MODEL_ANTHROPIC,
    timeoutMs,
  }))
  metrics.set('anthropic', providerMetrics('anthropic', env))
  providers.set('gemini', createGeminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL || env.AI_MODEL_GEMINI,
    timeoutMs,
  }))
  metrics.set('gemini', providerMetrics('gemini', env))

  return {
    register(provider) {
      assertProviderContract(provider)
      if (providers.has(provider.id)) throw new Error(`Provider "${provider.id}" is already registered.`)
      providers.set(provider.id, provider)
      metrics.set(provider.id, providerMetrics(provider.id, env))
      return () => {
        providers.delete(provider.id)
        metrics.delete(provider.id)
      }
    },
    list() {
      return [...providers.values()].map(({ id, name, model, capabilities, isAvailable }) => ({
        id,
        name,
        model: model || null,
        capabilities,
        available: isAvailable,
        keySuffix: ['openrouter', 'gemini'].includes(id) && env[id === 'openrouter' ? 'OPENROUTER_API_KEY' : 'GEMINI_API_KEY']?.trim()
          ? env[id === 'openrouter' ? 'OPENROUTER_API_KEY' : 'GEMINI_API_KEY'].trim().slice(-4)
          : null,
        secretSource: ['openrouter', 'gemini'].includes(id) ? 'Set in Cloudflare / .env' : null,
        ...metrics.get(id),
      }))
    },
    get(id) {
      return providers.get(id)
    },
    async discoverModels(id) {
      const provider = providers.get(id)
      if (!provider) throw new Error(`Unknown AI provider "${id}".`)
      return provider.discoverModels()
    },
  }
}

function workerUrl(value, envName) {
  if (!value?.trim()) return ''

  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`${envName} must be an absolute HTTPS URL.`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${envName} must be an HTTPS URL without credentials, query, or fragment.`)
  }
  return url.toString()
}

export const providerRegistry = createProviderRegistry()

function providerMetrics(id, env) {
  const key = id.toUpperCase()
  return {
    qualityScore: score(env[`AI_PROVIDER_QUALITY_SCORE_${key}`]),
    latencyScore: score(env[`AI_PROVIDER_LATENCY_SCORE_${key}`]),
    costScore: score(env[`AI_PROVIDER_COST_SCORE_${key}`]),
  }
}

function score(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(5, Math.max(1, parsed)) : 3
}
