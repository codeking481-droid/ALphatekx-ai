import { invokeWithProviderFallback } from './error-recovery.js'
import { buildPlanMessages, parsePlanGraph, PLAN_GRAPH_SCHEMA } from './plan-graph.js'

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
    planGraph = parsePlanGraph(result.text, { allowedToolIds })
  } catch {
    const repairMessages = [
      request.messages[0],
      ...request.messages.slice(1, -1),
      {
        role: 'system',
        content: [
          'Regenerate a valid PlanGraph from the original request and ObjectiveSpec because the previous response did not pass validation.',
          'Return only a complete JSON object with a tasks array that follows the PlanGraph instructions exactly.',
          'Do not invent tools or weaken approval requirements. For linkedin_post, provide the registered tool input with complete non-empty post text.',
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
    planGraph = parsePlanGraph(result.text, { allowedToolIds })
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
