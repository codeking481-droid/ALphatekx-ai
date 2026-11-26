import { fetchProvider, ProviderError, providerError, providerRequestSignal } from './errors.js'

export function createOpenAICompatibleProvider({
  id,
  name,
  baseUrl,
  apiKey,
  model,
  fallbackModels = [],
  timeoutMs,
  extraHeaders = {},
  supports = { textGeneration: true, streaming: true, toolCalling: true },
}) {
  const models = [...new Set([model, ...fallbackModels].filter((value) => typeof value === 'string' && value.trim()))]
  return {
    id,
    name,
    model,
    models,
    capabilities: {
      textGeneration: Boolean(model),
      streaming: Boolean(model) && Boolean(supports.streaming),
      structuredOutput: Boolean(model) && Boolean(supports.structuredOutput),
      toolCalling: Boolean(model) && Boolean(supports.toolCalling),
      imageUnderstanding: false,
      fileProcessing: false,
      embeddings: false,
    },
    isAvailable: Boolean(baseUrl && apiKey && model),
    async generate({ messages, tools, jsonSchema, signal }) {
      if (!baseUrl || !apiKey || !model) throw new ProviderError(`${name} is not configured.`, { provider: id, status: 503 })
      let lastError
      for (let index = 0; index < models.length; index += 1) {
        const activeModel = models[index]
        try {
          const response = await fetchProvider(id, `${baseUrl}/chat/completions`, {
            method: 'POST',
            signal: providerRequestSignal(signal, timeoutMs),
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extraHeaders },
            body: JSON.stringify({
              model: activeModel,
              messages,
              ...(['groq', 'openrouter'].includes(id) ? { temperature: 0.3 } : {}),
              ...(id === 'groq' ? { reasoning_effort: 'low' } : {}),
              ...(jsonSchema ? { response_format: { type: 'json_object' } } : {}),
              ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
            }),
          })
          if (!response.ok) throw providerError(id, response, await responseErrorDetail(response, apiKey))
          const data = await response.json()
          const choice = data.choices?.[0]
          return {
            text: choice?.message?.content || '',
            toolCalls: (choice?.message?.tool_calls || []).map((call) => ({
              id: call.id,
              name: call.function.name,
              arguments: JSON.parse(call.function.arguments || '{}'),
            })),
            usage: data.usage || null,
            model: data.model || activeModel,
          }
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error
          lastError = error
          if (index === models.length - 1 || !canTryAlternateModel(error)) throw error
        }
      }
      throw lastError || new ProviderError(`${name} has no configured models.`, { provider: id, status: 503 })
    },
    async *stream({ messages }) {
      if (!baseUrl || !apiKey || !model) throw new ProviderError(`${name} is not configured.`, { provider: id, status: 503 })
      const response = await fetchProvider(id, `${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify({ model, messages, stream: true }),
      })
      if (!response.ok) throw providerError(id, response, await responseErrorDetail(response, apiKey))
      if (!response.body) throw new ProviderError(`${name} did not return a response stream.`, { provider: id })
      for await (const line of readSseData(response.body)) {
        if (line === '[DONE]') break
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        const content = event.choices?.[0]?.delta?.content
        if (content) yield content
      }
    },
    async discoverModels() {
      if (!baseUrl || !apiKey) return []
      const response = await fetchProvider(id, `${baseUrl}/models`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
      })
      if (!response.ok) throw providerError(id, response, await responseErrorDetail(response, apiKey))
      const data = await response.json()
      return Array.isArray(data.data) ? data.data.map((item) => item.id).filter(Boolean) : []
    },
  }
}

async function* readSseData(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (line.startsWith('data:')) yield line.slice(5).trim()
      }
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }
}

async function responseErrorDetail(response, apiKey) {
  try {
    const body = await response.clone().text()
    let message = body
    try {
      const data = JSON.parse(body)
      message = data.error?.message || data.message || body
    } catch {
      message = body
    }

    return (apiKey ? String(message).split(apiKey).join('[REDACTED_PROVIDER_KEY]') : String(message))
      .replace(/gsk_[A-Za-z0-9_-]+/gi, '[REDACTED_GROQ_KEY]')
      .replace(/sk-or-v1-[A-Za-z0-9_-]+/gi, '[REDACTED_OPENROUTER_KEY]')
      .replace(/AIzaSy[A-Za-z0-9_-]+/gi, '[REDACTED_GEMINI_KEY]')
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
      .replace(/\s+/g, ' ')
      .slice(0, 500)
  } catch {
    return ''
  }
}

function canTryAlternateModel(error) {
  return Boolean(error.upstreamStatus) &&
    ![401, 402, 403, 429].includes(error.upstreamStatus)
}
