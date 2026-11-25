import { fetchProvider, ProviderError, providerError, providerRequestSignal } from './errors.js'

export function createOpenAICompatibleProvider({
  id,
  name,
  baseUrl,
  apiKey,
  model,
  timeoutMs,
  extraHeaders = {},
  supports = { textGeneration: true, streaming: true, toolCalling: true },
}) {
  return {
    id,
    name,
    model,
    capabilities: {
      textGeneration: Boolean(model),
      streaming: Boolean(model) && Boolean(supports.streaming),
      structuredOutput: false,
      toolCalling: Boolean(model) && Boolean(supports.toolCalling),
      imageUnderstanding: false,
      fileProcessing: false,
      embeddings: false,
    },
    isAvailable: Boolean(baseUrl && apiKey && model),
    async generate({ messages, tools, jsonSchema, signal }) {
      if (!baseUrl || !apiKey || !model) throw new ProviderError(`${name} is not configured.`, { provider: id, status: 503 })
      if (jsonSchema) throw new ProviderError(`${name} structured output is not enabled for this model configuration.`, { provider: id, status: 501 })
      const response = await fetchProvider(id, `${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: providerRequestSignal(signal, timeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify({
          model,
          messages,
          ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
        }),
      })
      if (!response.ok) throw providerError(id, response)
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
        model: data.model || model,
      }
    },
    async *stream({ messages }) {
      if (!baseUrl || !apiKey || !model) throw new ProviderError(`${name} is not configured.`, { provider: id, status: 503 })
      const response = await fetchProvider(id, `${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify({ model, messages, stream: true }),
      })
      if (!response.ok) throw providerError(id, response)
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
      if (!response.ok) throw providerError(id, response)
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
