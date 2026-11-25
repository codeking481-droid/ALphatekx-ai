const MAX_RESULTS = 5

export async function searchTavily({ query, maxResults = MAX_RESULTS, apiKey, fetchImpl = fetch }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('TAVILY_API_KEY is not configured on the server.')
  if (typeof query !== 'string' || !query.trim() || query.length > 400) {
    throw new Error('The web search query is invalid.')
  }
  const boundedResults = Number.isInteger(maxResults)
    ? Math.min(MAX_RESULTS, Math.max(1, maxResults))
    : MAX_RESULTS
  const response = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: query.trim(),
      search_depth: 'basic',
      max_results: boundedResults,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Tavily search returned HTTP ${response.status}.`)
  const payload = await response.json()
  const results = Array.isArray(payload?.results)
    ? payload.results.slice(0, boundedResults).map(normalizeResult).filter(Boolean)
    : []
  if (!results.length) throw new Error('The search provider returned no usable results.')
  return { query: query.trim(), provider: 'tavily', results }
}

function normalizeResult(result) {
  if (!result || typeof result.title !== 'string' || typeof result.url !== 'string' ||
    typeof result.content !== 'string') return null
  let url
  try {
    url = new URL(result.url)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  return {
    title: result.title.trim().slice(0, 300),
    url: url.toString(),
    content: result.content.trim().slice(0, 2000),
    ...(Number.isFinite(result.score) ? { score: result.score } : {}),
  }
}
