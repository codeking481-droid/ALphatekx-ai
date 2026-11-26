import { decryptCredential, encryptCredential } from '../integrations/credential-vault.js'
import { config } from '../config.js'
import { createAnthropicProvider } from '../providers/anthropic.js'
import { createGeminiProvider } from '../providers/gemini.js'
import { createOpenAICompatibleProvider } from '../providers/openai-compatible.js'

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    defaultModel: 'gpt-4.1-mini',
    create: (key, env) => createOpenAICompatibleProvider({
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: key,
      model: env.AI_MODEL_OPENAI || 'gpt-4.1-mini',
      timeoutMs: config.aiRequestTimeoutMs,
    }),
  },
  anthropic: {
    name: 'Claude',
    defaultModel: 'claude-3-7-sonnet-latest',
    create: (key, env) => createAnthropicProvider({
      apiKey: key,
      model: env.AI_MODEL_ANTHROPIC || 'claude-3-7-sonnet-latest',
      timeoutMs: config.aiRequestTimeoutMs,
    }),
  },
  gemini: {
    name: 'Gemini',
    defaultModel: 'gemini-2.5-flash',
    create: (key, env) => createGeminiProvider({
      apiKey: key,
      model: env.AI_MODEL_GEMINI || 'gemini-2.5-flash',
      timeoutMs: config.aiRequestTimeoutMs,
    }),
  },
  groq: {
    name: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    create: (key, env) => createOpenAICompatibleProvider({
      id: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: key,
      model: env.AI_MODEL_GROQ || 'llama-3.3-70b-versatile',
      timeoutMs: config.aiRequestTimeoutMs,
    }),
  },
}

export async function saveUserApiKey({ userId, providerId, apiKey, database }) {
  const provider = PROVIDERS[providerId]
  if (!provider) throw Object.assign(new Error('Choose OpenAI, Claude, Gemini, or Groq.'), { status: 400 })
  if (typeof apiKey !== 'string' || apiKey.trim().length < 8 || apiKey.length > 2000 ||
    /[\r\n]/.test(apiKey)) {
    throw Object.assign(new Error('API key must be between 8 and 2000 characters.'), { status: 400 })
  }
  const secret = apiKey.trim()
  const sealed = encryptCredential(JSON.stringify({ apiKey: secret }))
  await database.query(
    `INSERT INTO integration_accounts (user_id, provider_id, encrypted_credentials, credential_key_version)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, provider_id) DO UPDATE SET encrypted_credentials = EXCLUDED.encrypted_credentials,
       credential_key_version = EXCLUDED.credential_key_version, updated_at = now()`,
    [userId, `byok:${providerId}`, sealed.value, sealed.version],
  )
  return { provider: providerId, configured: true, keySuffix: secret.slice(-4) }
}

export async function listUserApiKeys({ userId, database }) {
  const { rows } = await database.query(
    `SELECT provider_id, encrypted_credentials, credential_key_version
     FROM integration_accounts WHERE user_id = $1 AND provider_id LIKE 'byok:%'`,
    [userId],
  )
  const keys = rows.map((row) => {
    const providerId = row.provider_id.slice('byok:'.length)
    if (!PROVIDERS[providerId]) return null
    const credentials = JSON.parse(decryptCredential({
      value: row.encrypted_credentials,
      version: row.credential_key_version,
    }))
    return { provider: providerId, configured: true, keySuffix: credentials.apiKey.slice(-4) }
  }).filter(Boolean)
  return { keys, hasOwnKey: keys.length > 0 }
}

export async function removeUserApiKey({ userId, providerId, database }) {
  if (!PROVIDERS[providerId]) throw Object.assign(new Error('Choose OpenAI, Claude, Gemini, or Groq.'), { status: 400 })
  const result = await database.query(
    'DELETE FROM integration_accounts WHERE user_id = $1 AND provider_id = $2',
    [userId, `byok:${providerId}`],
  )
  return result.rowCount > 0
}

export async function withUserProviderRegistry({ userId, database, registry, env = process.env }, operation) {
  const { rows } = await database.query(
    `SELECT provider_id, encrypted_credentials, credential_key_version
     FROM integration_accounts WHERE user_id = $1 AND provider_id LIKE 'byok:%'`,
    [userId],
  )
  const userProviders = new Map()
  for (const row of rows) {
    const providerId = row.provider_id.slice('byok:'.length)
    const definition = PROVIDERS[providerId]
    if (!definition) continue
    const credentials = JSON.parse(decryptCredential({
      value: row.encrypted_credentials,
      version: row.credential_key_version,
    }))
    userProviders.set(providerId, definition.create(credentials.apiKey, env))
  }
  if (!userProviders.size) return operation(registry)
  const mergedProviders = new Map(userProviders)
  const userRegistry = {
    list: () => [
      ...registry.list().filter(({ id }) => !mergedProviders.has(id)),
      ...[...mergedProviders.values()].map(({ id, name, model, capabilities, isAvailable }) => ({
        id, name, model, capabilities, available: isAvailable,
        keySuffix: null,
        qualityScore: 3, latencyScore: 3, costScore: 3,
      })),
    ],
    get: (id) => mergedProviders.get(id) || registry.get(id),
    discoverModels: (id) => mergedProviders.get(id)?.discoverModels() || registry.discoverModels(id),
  }
  return operation(userRegistry)
}

export function listSupportedApiKeyProviders() {
  return Object.entries(PROVIDERS).map(([id, provider]) => ({
    id,
    name: provider.name,
    defaultModel: provider.defaultModel,
  }))
}
