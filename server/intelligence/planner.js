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
  return {
    planGraph: parsePlanGraph(completion.result.text, { allowedToolIds }),
    provider: completion.provider,
    model: completion.result.model || completion.provider.model,
    usage: completion.result.usage || null,
    fallbackUsed: completion.fallbackUsed === true,
  }
}

export { buildPlanMessages, parsePlanGraph, PLAN_GRAPH_SCHEMA }
