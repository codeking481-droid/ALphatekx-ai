import { log } from '../observability/logger.js'
import { ProviderError } from './errors.js'
import { invokeModel } from '../intelligence/model-invocation.js'

export const FALLBACK_PROVIDER_IDS = ['openrouter', 'gemini', 'workers_ai', 'groq']

export const localFallbackProvider = {
  id: 'local-fallback',
  name: 'Local template',
  model: null,
  isAvailable: true,
  capabilities: { textGeneration: true, structuredOutput: false, toolCalling: false },
}

export function formatFallbackTrace(trace) {
  if (!trace?.length) return ''
  const failures = trace.filter((item) => item.status === 'failed')
  if (!failures.length) return ''
  const uniqueFailures = [...new Map(failures.map((item) => [item.provider, item])).values()]
  const providerNames = uniqueFailures.map((item) => {
    if (isFreeQuotaFailure(item.provider, item.upstreamStatus)) return `${item.name} free quota used`
    const status = item.upstreamStatus ? ` ${item.upstreamStatus}` : ''
    return `${item.name} failed${status}`
  })
  const used = trace.at(-1)
  const lead = providerNames.join(', ')
  if (used.status === 'local') return `${lead}; tried the local fallback.`
  return `${lead}; tried ${used.name} fallback.`
}

function isFreeQuotaFailure(provider, upstreamStatus) {
  return (provider === 'openrouter' && upstreamStatus === 402) ||
    (provider === 'gemini' && upstreamStatus === 429)
}

export function freeQuotaFailureMessage(provider, upstreamStatus) {
  return isFreeQuotaFailure(provider, upstreamStatus)
    ? 'Free quota used, tried next fallback.'
    : null
}

export async function invokeFallbackChain(registry, preferredProvider, messages, options = {}) {
  if (options.signal?.aborted) {
    throw options.signal.reason || new Error('Model request was cancelled.')
  }

  const trace = []
  const ordered = []
  const hasPrimaryChain = FALLBACK_PROVIDER_IDS.some((id) => registry.get(id))
  let lastError = null
  const candidateIds = hasPrimaryChain
    ? FALLBACK_PROVIDER_IDS
    : [preferredProvider?.id, ...registry.list().filter((item) => item.available !== false).map((item) => item.id)].filter(Boolean)
  for (const id of candidateIds) {
    const provider = registry.get(id) || (preferredProvider?.id === id ? preferredProvider : null)
    if (provider && provider.isAvailable !== false && !options.exclude?.includes(provider.id) &&
      !ordered.some((item) => item.id === provider.id)) {
      ordered.push(provider)
    }
  }

  for (const provider of ordered) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const startedAt = Date.now()
      try {
        const signal = shorterRequestSignal(options.signal, 30_000)
        const requiresJson = options.jsonSchema || (hasPrimaryChain && expectsJson(messages))
        const result = await invokeModel(provider, attempt === 1 ? messages : shortenMessages(messages, requiresJson), {
          ...options,
          signal,
          capability: options.capability || 'textGeneration',
        })
        if (requiresJson) {
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
        lastError = error
        const upstreamStatus = error.upstreamStatus || (error.status >= 400 ? error.status : null)
        const freeQuotaFailure = isFreeQuotaFailure(provider.id, upstreamStatus)
        if (error.code === 'invalid_json' && attempt === 1) {
          log('warn', 'ai.provider.invalid_json', {
            provider: provider.id,
            providerName: provider.name,
            model: provider.model || null,
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
          model: provider.model || null,
          upstreamStatus,
          code: error.code || null,
          message: freeQuotaFailure
            ? 'Free-tier quota exhausted.'
            : redactSecrets(error.message || 'Provider request failed.'),
        })
        if (!freeQuotaFailure && error.retryable !== false && attempt === 1) {
          continue
        }
        if (!hasPrimaryChain && error.retryable === false) throw error
        break
      }
    }
  }

  if (!hasPrimaryChain && ordered.length && lastError &&
    (lastError.retryable === false || lastError.code === 'invalid_json')) {
    throw lastError
  }

  trace.push({ name: 'Local fallback', provider: 'local-fallback', status: 'local', upstreamStatus: null })
  log('warn', 'ai.local_fallback.used', {
    provider: 'local-fallback',
    providersAttempted: trace.filter((item) => item.status === 'failed').map((item) => item.provider),
  })
  return {
    provider: localFallbackProvider,
    result: {
      text: createLocalTemplate(messages),
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

function shortenMessages(messages, requiresJson) {
  const shortened = messages.map((message) => ({
    ...message,
    content: typeof message.content === 'string'
      ? message.content.slice(0, 12_000)
      : message.content,
  }))
  const retryHint = {
    role: 'system',
    content: requiresJson
      ? 'Retry with a shorter prompt. Return ONLY valid JSON, no markdown, no explanation.'
      : 'Retry with a shorter prompt and answer the user request directly.',
  }
  return [retryHint, ...shortened]
}

function redactSecrets(value) {
  return String(value)
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/gi, '[REDACTED_OPENROUTER_KEY]')
    .replace(/AIzaSy[A-Za-z0-9_-]+/gi, '[REDACTED_GEMINI_KEY]')
    .replace(/gsk_[A-Za-z0-9_-]+/gi, '[REDACTED_GROQ_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
}

function expectsJson(messages) {
  const firstSystemPrompt = messages.find((message) => message.role === 'system')?.content || ''
  return /Extract an ObjectiveSpec as one JSON object|Create a PlanGraph as one JSON object|Return a valid PlanGraph/.test(firstSystemPrompt)
}

function createLocalTemplate(messages) {
  const prompt = messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n')
  const userMessage = [...messages].reverse().find((message) => message.role === 'user')?.content || ''
  const firstSystemPrompt = messages.find((message) => message.role === 'system')?.content || ''
  if (/Extract an ObjectiveSpec as one JSON object/.test(firstSystemPrompt)) {
    const motionRequest = /\b(motion graphics?|animation|animated intro|logo animation|animated text)\b/i.test(userMessage)
    return JSON.stringify({
      goal: userMessage.slice(0, 1000) || 'Respond helpfully to the request.',
      deliverables: motionRequest ? ['A downloadable HTML animation'] : ['A helpful response'],
      resources: motionRequest ? ['motion_graphics_create'] : [],
      scopeConstraints: [],
      timeConstraints: [],
      instructions: ['Use deterministic local fallback behavior because AI providers are unavailable.'],
      successCriteria: motionRequest ? ['Create and return the HTML animation file.'] : ['Address the user request honestly.'],
      missingInformation: [],
      ambiguities: [],
      assumptions: [],
      riskClassification: 'low',
      planningRequired: motionRequest,
      requiresExternalAction: false,
    })
  }
  if (/Create a PlanGraph as one JSON object|Return a valid PlanGraph/.test(firstSystemPrompt)) {
    const motionRequest = /\b(motion graphics?|animation|animated intro|logo animation|animated text)\b/i.test(userMessage)
    const externalLinkedInPost = /\b(?:post|publish|share)\b[\s\S]*\blinkedin\b|\blinkedin\b[\s\S]*\b(?:post|publish|share)\b/i.test(userMessage)
    const linkedInDraftRequest = /\b(?:draft|write|create|compose)\b[\s\S]{0,100}\blinkedin\b/i.test(userMessage)
    const toolId = motionRequest && prompt.includes('motion_graphics_create')
      ? 'motion_graphics_create'
      : (externalLinkedInPost || linkedInDraftRequest) && prompt.includes('linkedin_post')
        ? 'linkedin_post'
        : null
    const task = toolId
      ? {
          id: 'local-tool-task',
          description: toolId === 'motion_graphics_create'
            ? 'Create a Biz motion graphics intro using the local HTML template.'
            : 'Create the exact LinkedIn post draft for approval.',
          type: 'tool',
          requiredInputs: [{ kind: 'tool_output', description: `Result from ${toolId}.`, toolId }],
          dependencies: [],
          expectedOutput: 'A completed tool result.',
          acceptanceCriteria: ['The result is available to the user.'],
          riskClassification: toolId === 'linkedin_post' ? 'medium' : 'low',
          requiredCapability: 'tool_execution',
          specialistRole: 'execution',
          maxAttempts: 1,
          completionConditions: ['Tool execution completed.'],
          toolInput: toolId === 'linkedin_post' ? { text: buildLinkedInDraftText(userMessage) } : {},
        }
      : {
          id: 'local-response-task',
          description: 'Prepare a useful response from the user request and available context.',
          type: 'analysis',
          requiredInputs: [{ kind: 'user_request', description: 'The current user request.' }],
          dependencies: [],
          expectedOutput: 'A concise response.',
          acceptanceCriteria: ['The response addresses the user request.'],
          riskClassification: 'low',
          requiredCapability: 'reasoning',
          specialistRole: 'general',
          maxAttempts: 1,
          completionConditions: ['The response is present.'],
        }
    return JSON.stringify({ tasks: [task] })
  }
  if (/\blinkedin\b/i.test(userMessage) && /\b(?:draft|write|create|compose)\b/i.test(userMessage)) {
    return createLinkedInDraft(userMessage)
  }
  const quotedRequest = String(userMessage).trim().replace(/\s+/g, ' ').slice(0, 1200)
  if (/execution report|motion graphic html was created/i.test(prompt) && /\/api\/files\/[a-f0-9-]{36}/i.test(prompt)) {
    const fileUrl = /\/api\/files\/[a-f0-9-]{36}/i.exec(prompt)?.[0]
    return `Main AI was down, I used fallback. I created the requested motion graphic with Biz's charcoal-and-emerald local template.\n\n[Preview the animation](${fileUrl}/preview) · [Download the HTML](${fileUrl})`
  }
  return quotedRequest
    ? `Main AI was down, I used fallback. I can still help with your request: "${quotedRequest}"`
    : 'Main AI was down, I used a local fallback. Please tell me what you would like help with.'
}

function createLinkedInDraft(message) {
  return [
    'Main AI was down, I used fallback. Here is a LinkedIn draft based on your request (not posted):',
    '',
    buildLinkedInDraftText(message),
  ].join('\n')
}

function buildLinkedInDraftText(message) {
  const explicitText = /\blinkedin\b\s*:\s*([\s\S]+)$/i.exec(message)?.[1]?.trim()
  if (explicitText) return explicitText.slice(0, 3000)
  const topic = /\b(?:about|on|around)\s+(.+)$/i.exec(message)?.[1]
    ?.replace(/[.!?]+$/, '')
    .trim()
  const source = topic || message
    .replace(/^(?:please\s+)?(?:draft|write|create)\s+(?:a\s+)?(?:linkedin\s+)?(?:post|draft)?\s*(?:about|on|around)?\s*/i, '')
    .trim()
  const subject = source.slice(0, 500) || 'the idea you shared'
  const hashtag = subject.toLowerCase().match(/[a-z0-9]{3,}/g)?.[0] || 'Ideas'
  return [
    `A thought worth sharing: ${subject}.`,
    '',
    'It is a good opportunity to reflect on what this means for our work and the possibilities ahead.',
    '',
    'What is your perspective?',
    '',
    `#${hashtag}`,
  ].join('\n')
}
