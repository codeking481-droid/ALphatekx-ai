import { invokeModel } from './model-invocation.js'

export async function runModelReviews({
  registry,
  providerIds,
  messages,
  mode = 'parallel',
  userId = null,
  requestId = null,
  database,
  signal = null,
}) {
  if (!['parallel', 'sequential'].includes(mode)) throw new Error('Execution mode must be parallel or sequential.')
  const uniqueIds = [...new Set(providerIds)]
  if (uniqueIds.length < 2) throw new Error('Independent review requires at least two distinct providers.')
  const providers = uniqueIds.map((id) => {
    const provider = registry.get(id)
    if (!provider?.isAvailable || !provider.capabilities?.textGeneration) {
      throw new Error(`Provider "${id}" is not configured for text generation.`)
    }
    return provider
  })
  if (providers.length < 2) throw new Error('Review providers must be distinct.')

  const review = async (provider) => ({
    provider: provider.id,
    result: await invokeModel(provider, [
      { role: 'system', content: 'Review the request independently. Give concise findings and uncertainties, not hidden reasoning.' },
      ...messages,
    ], {
      userId,
      requestId,
      database,
      capability: 'text_generation',
      signal,
    }),
  })

  if (mode === 'parallel') return Promise.all(providers.map(review))
  const results = []
  for (const provider of providers) results.push(await review(provider))
  return results
}
