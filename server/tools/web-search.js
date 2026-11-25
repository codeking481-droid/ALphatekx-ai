import { runIsolatedWebSearch } from './isolated-web-search.js'
import { registerTool } from './registry.js'

export function registerWebSearchTool() {
  return registerTool({
    id: 'web_search',
    description: 'Search the public web for current information and return a small set of cited results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 400 },
        max_results: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    permissions: ['tool:approved'],
    requiresApproval: true,
    retrySafe: true,
    timeoutMs: 20_000,
    auditDetails: (input) => ({ query: input.query, max_results: input.max_results || 5 }),
    validate: (input) => typeof input?.query === 'string' &&
      input.query.trim().length > 0 &&
      input.query.length <= 400 &&
      (input.max_results === undefined || (Number.isInteger(input.max_results) && input.max_results >= 1 && input.max_results <= 5)),
    execute: ({ input, signal }) => runIsolatedWebSearch({
      query: input.query.trim(),
      maxResults: input.max_results || 5,
      signal,
    }),
    verifyResult: (result) => Boolean(result && Array.isArray(result.results) &&
      result.results.length > 0 &&
      result.results.every((item) => typeof item.title === 'string' &&
        typeof item.url === 'string' && isHttpsUrl(item.url) &&
        typeof item.content === 'string')),
  })
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}
