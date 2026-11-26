import { invokeWithProviderFallback } from './error-recovery.js'
import {
  buildPlanMessages,
  createFallbackToolPlan,
  parsePlanGraph,
  PLAN_GRAPH_SCHEMA,
} from './plan-graph.js'

export async function createPlanGraph(registry, provider, {
  message,
  objective,
  contextMessages = [],
  attachmentContext = '',
  userId,
  requestId = null,
  database,
  signal = null,
  allowedToolIds = null,
  requiresExternalAction = false,
  skill = null,
}) {
  const request = {
    messages: buildPlanMessages({ message, objective, contextMessages, attachmentContext, allowedToolIds }),
    ...(provider.capabilities?.structuredOutput ? { jsonSchema: PLAN_GRAPH_SCHEMA } : {}),
  }
  const completion = await invokeWithProviderFallback(registry, provider, request, { userId, requestId, database, signal })
  let result = completion.result
  let activeProvider = completion.provider
  let fallbackUsed = completion.fallbackUsed === true
  let planGraph
  try {
    planGraph = parsePlanGraph(result.text, {
      allowedToolIds,
      requiresExternalAction,
      message,
      skill,
    })
  } catch {
    const repairMessages = [
      request.messages[0],
      ...request.messages.slice(1, -1),
      {
        role: 'system',
        content: [
          'Regenerate a valid PlanGraph from the original request and ObjectiveSpec because the previous response did not pass validation.',
          'Return only a complete JSON object with a tasks array that follows the PlanGraph instructions exactly.',
          'Do not invent tools or weaken approval requirements. For an external action, use exactly one matching registered tool and provide complete valid inputs.',
        ].join(' '),
      },
      request.messages.at(-1),
      {
        role: 'user',
        content: 'The previous response was invalid. Generate a fresh PlanGraph; do not repeat or rely on the malformed response.',
      },
    ]
    const repair = await invokeWithProviderFallback(
      registry,
      completion.provider,
      {
        messages: repairMessages,
        ...(completion.provider.capabilities?.structuredOutput ? { jsonSchema: PLAN_GRAPH_SCHEMA } : {}),
      },
      { userId, requestId, database, signal },
    )
    activeProvider = repair.provider
    fallbackUsed ||= repair.fallbackUsed === true
    result = repair.result
    try {
      planGraph = parsePlanGraph(result.text, {
        allowedToolIds,
        requiresExternalAction,
        message,
        skill,
      })
    } catch (repairError) {
      const fallback = requiresExternalAction
        ? createFallbackToolPlan({ message, allowedToolIds, skill })
        : null
      if (!fallback) throw repairError
      planGraph = parsePlanGraph(JSON.stringify(fallback), {
        allowedToolIds,
        requiresExternalAction,
        message,
        skill,
      })
    }
  }
  return {
    planGraph,
    provider: activeProvider,
    model: result.model || activeProvider.model,
    usage: result.usage || completion.result.usage || null,
    fallbackUsed,
  }
}

export { buildPlanMessages, parsePlanGraph, PLAN_GRAPH_SCHEMA }
