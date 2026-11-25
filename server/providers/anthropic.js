import { fetchProvider, ProviderError, providerError, providerRequestSignal } from './errors.js'

export function createAnthropicProvider({ apiKey, model, timeoutMs }) {
  const headers = {
    'x-api-key': apiKey || '',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
  return {
    id: 'anthropic',
    name: 'Anthropic',
    model,
    capabilities: {
      textGeneration: Boolean(model),
      streaming: Boolean(model),
      structuredOutput: false,
      toolCalling: Boolean(model),
      imageUnderstanding: false,
      fileProcessing: false,
      embeddings: false,
    },
    isAvailable: Boolean(apiKey && model),
    async generate({ messages, tools, jsonSchema, signal }) {
      if (!apiKey || !model) throw new ProviderError('Anthropic is not configured.', { provider: 'anthropic', status: 503 })
      if (jsonSchema) throw new ProviderError('Anthropic structured output is not enabled for this model configuration.', { provider: 'anthropic', status: 501 })
      const system = messages.find((message) => message.role === 'system')?.content
      const response = await fetchProvider('anthropic', 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: providerRequestSignal(signal, timeoutMs),
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          ...(system ? { system } : {}),
          messages: messages.filter((message) => message.role !== 'system'),
          ...(tools?.length ? {
            tools: tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              input_schema: tool.function.parameters,
            })),
          } : {}),
        }),
      })
      if (!response.ok) throw providerError('anthropic', response)
      const data = await response.json()
      return {
        text: (data.content || []).filter((item) => item.type === 'text').map((item) => item.text).join(''),
        toolCalls: (data.content || [])
          .filter((item) => item.type === 'tool_use')
          .map((item) => ({ id: item.id, name: item.name, arguments: item.input })),
        usage: data.usage || null,
        model: data.model || model,
      }
    },
    async *stream({ messages }) {
      if (!apiKey || !model) throw new ProviderError('Anthropic is not configured.', { provider: 'anthropic', status: 503 })
      const system = messages.find((message) => message.role === 'system')?.content
      const response = await fetchProvider('anthropic', 'https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers,
        body: JSON.stringify({
          model, max_tokens: 4096, stream: true,
          ...(system ? { system } : {}),
          messages: messages.filter((message) => message.role !== 'system'),
        }),
      })
      if (!response.ok) throw providerError('anthropic', response)
      if (!response.body) throw new ProviderError('Anthropic did not return a response stream.', { provider: 'anthropic' })
      for await (const line of readSseData(response.body)) {
        if (!line) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') yield event.delta.text
        } catch {
          continue
        }
      }
    },
    async discoverModels() {
      if (!apiKey) return []
      const response = await fetchProvider('anthropic', 'https://api.anthropic.com/v1/models?limit=1000', {
        signal: AbortSignal.timeout(timeoutMs),
        headers,
      })
      if (!response.ok) throw providerError('anthropic', response)
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
      for (const line of lines) if (line.startsWith('data:')) yield line.slice(5).trim()
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }
}
