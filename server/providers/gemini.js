import { fetchProvider, ProviderError, providerError, providerRequestSignal } from './errors.js'

export function createGeminiProvider({ apiKey, model, timeoutMs }) {
  const endpoint = (suffix = '') => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}${suffix}`
  return {
    id: 'gemini',
    name: 'Google Gemini',
    model,
    capabilities: {
      textGeneration: Boolean(model),
      streaming: Boolean(model),
      structuredOutput: Boolean(model),
      toolCalling: Boolean(model),
      imageUnderstanding: false,
      fileProcessing: false,
      embeddings: false,
    },
    isAvailable: Boolean(apiKey && model),
    async generate({ messages, tools, jsonSchema, signal }) {
      if (!apiKey || !model) throw new ProviderError('Google Gemini is not configured.', { provider: 'gemini', status: 503 })
      const system = messages.find((message) => message.role === 'system')?.content
      const response = await fetchProvider('gemini', endpoint(':generateContent'), {
        method: 'POST',
        signal: providerRequestSignal(signal, timeoutMs),
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: messages.filter((message) => message.role !== 'system').map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
          ...(tools?.length ? { tools: [{ functionDeclarations: tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          })) }] } : {}),
          ...(jsonSchema ? { generationConfig: { responseMimeType: 'application/json', responseSchema: jsonSchema } } : {}),
        }),
      })
      if (!response.ok) throw providerError('gemini', response)
      const data = await response.json()
      const parts = data.candidates?.[0]?.content?.parts || []
      return {
        text: parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join(''),
        toolCalls: parts.filter((part) => part.functionCall).map((part, index) => ({
          id: `${data.responseId || 'call'}-${index}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {},
        })),
        usage: data.usageMetadata || null,
        model,
      }
    },
    async *stream({ messages }) {
      if (!apiKey || !model) throw new ProviderError('Google Gemini is not configured.', { provider: 'gemini', status: 503 })
      const system = messages.find((message) => message.role === 'system')?.content
      const response = await fetchProvider('gemini', endpoint(':streamGenerateContent?alt=sse'), {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: messages.filter((message) => message.role !== 'system').map((message) => ({
            role: message.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: message.content }],
          })),
        }),
      })
      if (!response.ok) throw providerError('gemini', response)
      if (!response.body) throw new ProviderError('Google Gemini did not return a response stream.', { provider: 'gemini' })
      for await (const line of readSseData(response.body)) {
        if (!line) continue
        try {
          const event = JSON.parse(line)
          for (const part of event.candidates?.[0]?.content?.parts || []) if (part.text) yield part.text
        } catch {
          continue
        }
      }
    },
    async discoverModels() {
      if (!apiKey) return []
      const response = await fetchProvider('gemini', 'https://generativelanguage.googleapis.com/v1beta/models', {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'x-goog-api-key': apiKey },
      })
      if (!response.ok) throw providerError('gemini', response)
      const data = await response.json()
      return Array.isArray(data.models)
        ? data.models.filter((item) => item.supportedGenerationMethods?.includes('generateContent')).map((item) => item.name.replace(/^models\//, ''))
        : []
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
