import { config } from '../config.js'
import { createAnthropicProvider } from './anthropic.js'
import { createGeminiProvider } from './gemini.js'
import { assertProviderContract } from './interface.js'
import { createOpenAICompatibleProvider } from './openai-compatible.js'
import { createCloudflareWorkerProvider } from './cloudflare-worker.js'
import { createCloudflareWorkersAiProvider } from './cloudflare-workers-ai.js'

const OPENROUTER_FREE_MODELS = [
  'google/gemma-4-31b-it:free',
]
const GEMINI_FREE_MODEL = 'gemini-2.5-flash'
const GROQ_FREE_MODEL = 'openai/gpt-oss-120b'
const WORKERS_AI_FREE_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
]

const compatibleProviders = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', key: 'DEEPSEEK_API_KEY' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', key: 'MISTRAL_API_KEY' },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    key: 'GROQ_API_KEY',
    defaultModel: GROQ_FREE_MODEL,
  },
  { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', key: 'XAI_API_KEY' },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    key: 'OPENROUTER_API_KEY',
    defaultModel: OPENROUTER_FREE_MODELS[0],
    fallbackModels: OPENROUTER_FREE_MODELS.slice(1),
    headers: { 'HTTP-Referer': process.env.WEB_ORIGIN || 'http://localhost:5173', 'X-Title': 'Biz' },
    supports: { textGeneration: true, streaming: true, toolCalling: true, structuredOutput: true },
  },
]

export function createProviderRegistry(env = process.env) {
  const providers = new Map()
  const metrics = new Map()
  const timeoutMs = config.aiRequestTimeoutMs

  const workersAi = createCloudflareWorkersAiProvider({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    timeoutMs,
    models: WORKERS_AI_FREE_MODELS,
  })
  providers.set(workersAi.id, workersAi)
  metrics.set(workersAi.id, providerMetrics(workersAi.id, env))

  for (const definition of compatibleProviders) {
    metrics.set(definition.id, providerMetrics(definition.id, env))
    providers.set(definition.id, createOpenAICompatibleProvider({
      ...definition,
      apiKey: env[definition.key],
      model: definition.id === 'openrouter'
        ? definition.defaultModel
        : definition.id === 'groq'
          ? GROQ_FREE_MODEL
          : env[`AI_MODEL_${definition.id.toUpperCase()}`],
      fallbackModels: definition.fallbackModels,
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
    model: GEMINI_FREE_MODEL,
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
        keySuffix: providerKeySuffix(id, env),
        secretSource: ['openrouter', 'gemini'].includes(id) && providerKeySuffix(id, env)
          ? 'Set in server environment'
          : null,
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

function providerKeySuffix(id, env) {
  const keyName = {
    openrouter: 'OPENROUTER_API_KEY',
    gemini: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
  }[id]
  return keyName && env[keyName]?.trim() ? env[keyName].trim().slice(-4) : null
}
