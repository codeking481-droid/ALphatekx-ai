import { log } from '../observability/logger.js'
import { ProviderError } from './errors.js'
import { invokeModel } from '../intelligence/model-invocation.js'
import { createBuiltInMotionInput } from '../tools/motion-graphics.js'
import { isMotionGraphicsRequest } from '../intelligence/motion-graphics-intent.js'

const MAX_RATE_LIMIT_RETRY_WAIT_MS = 15_000

export const FALLBACK_PROVIDER_IDS = ['groq', 'workers_ai', 'openrouter', 'gemini', 'worker1']
export const PRIMARY_PROVIDER_IDS = FALLBACK_PROVIDER_IDS.filter((id) => id !== 'worker1')

export const localFallbackProvider = {
  id: 'local-fallback',
  name: 'Local template',
  model: null,
  isAvailable: true,
  capabilities: { textGeneration: true, structuredOutput: false, toolCalling: false },
}

export function formatFallbackTrace(trace) {
  if (!trace?.length) return ''
  const issues = trace.filter((item) => item.status === 'failed' || item.status === 'skipped')
  if (!issues.length) {
    return trace.at(-1)?.status === 'local'
      ? 'No usable AI response was available; tried the local fallback.'
      : ''
  }
  const uniqueIssues = [...new Map(issues.map((item) => [item.provider, item])).values()]
  const providerNames = uniqueIssues.map((item) => {
    if (item.status === 'skipped') return `${item.name} not configured`
    if (isFreeQuotaFailure(item.provider, item.upstreamStatus)) return `${item.name} free quota used`
    const status = item.upstreamStatus ? ` ${item.upstreamStatus}` : ''
    return `${item.name} failed${status}`
  })
  const used = trace.at(-1)
  const lead = providerNames.join(', ')
  if (used.status === 'local') return `${lead}; tried the local fallback.`
  if (used.status === 'used' && uniqueIssues.some((item) => item.status === 'failed' && item.provider === used.provider)) {
    return `${lead}; ${used.name} recovered after retry.`
  }
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
  const hasPrimaryChain = PRIMARY_PROVIDER_IDS.some((id) => registry.get(id))
  let lastError = null
  const candidateIds = hasPrimaryChain
    ? FALLBACK_PROVIDER_IDS
    : [preferredProvider?.id, ...registry.list().filter((item) => item.available !== false).map((item) => item.id)].filter(Boolean)
  for (const id of candidateIds) {
    const provider = registry.get(id) || (preferredProvider?.id === id ? preferredProvider : null)
    if (provider && !options.exclude?.includes(provider.id) &&
      !ordered.some((item) => item.id === provider.id)) {
      ordered.push(provider)
    }
  }

  for (const provider of ordered) {
    if (provider.isAvailable === false) {
      trace.push({
        name: provider.name,
        provider: provider.id,
        status: 'skipped',
        reason: 'not_configured',
      })
      continue
    }
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
          fallbackUsed: trace.some((item) => item.status === 'skipped') ||
            trace.some((item) => item.status === 'failed' && item.provider !== provider.id),
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
          if (upstreamStatus === 429) {
            const retryDelayMs = parseRetryAfter(error.retryAfter)
            if (retryDelayMs === null) break
            await waitForRetry(retryDelayMs, options.signal)
          }
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
    providersSkipped: trace.filter((item) => item.status === 'skipped').map((item) => item.provider),
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

function parseRetryAfter(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const seconds = Number(value)
  const delayMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  if (!Number.isFinite(delayMs) || delayMs > MAX_RATE_LIMIT_RETRY_WAIT_MS) return null
  return Math.max(0, Math.ceil(delayMs))
}

function waitForRetry(delayMs, signal) {
  if (!delayMs) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(signal.reason || new Error('Model request was cancelled.'))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', abort, { once: true })
  })
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
    const motionRequest = isMotionGraphicsRequest(userMessage, messages)
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
    const motionRequest = isMotionGraphicsRequest(userMessage, messages) ||
      /motion-graphics regeneration/i.test(prompt)
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
            ? 'Use the built-in motion graphics template because no usable AI-generated plan was available.'
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
          toolInput: toolId === 'linkedin_post'
            ? { text: buildLinkedInDraftText(userMessage) }
            : createBuiltInMotionInput(userMessage, 'providers-unavailable'),
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
    if (/generationSource["']?\s*:\s*["']built-in-template/i.test(prompt)) {
      return `AI providers were down, so this is a built-in template, not AI-generated. Retry in 2 mins for real AI generation.\n\n[Preview the animation](${fileUrl}/preview) · [Download the HTML](${fileUrl})`
    }
    return `The requested AI-generated motion graphic is ready.\n\n[Preview the animation](${fileUrl}/preview) · [Download the HTML](${fileUrl})`
  }
  if (/^(?:hi|hello|hey|good morning|good afternoon|good evening)[!. ]*$/i.test(quotedRequest)) {
    return 'Hi! What can I help you with?'
  }
  return quotedRequest
    ? `I can help with your request: "${quotedRequest}". What would you like to do next?`
    : 'What would you like help with?'
}

function createLinkedInDraft(message) {
  return [
    'Here is a LinkedIn draft based on your request (not posted):',
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
