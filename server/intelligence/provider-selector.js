import { config } from '../config.js'

export function selectProvider(registry, {
  preferred = config.aiProvider,
  exclude = [],
  capability = 'textGeneration',
} = {}) {
  const candidates = registry.list()
    .filter((provider) => provider.available && provider.capabilities?.[capability] && !exclude.includes(provider.id))
  if (preferred) {
    const selected = candidates.find((provider) => provider.id === preferred)
    if (selected) return registry.get(selected.id)
  }
  const selected = candidates.sort((left, right) => providerScore(right) - providerScore(left))[0]
  if (!selected) {
    const error = new Error('No AI provider is configured. Add a provider API key and model to the server environment.')
    error.status = 503
    throw error
  }
  return registry.get(selected.id)
}

function providerScore(provider) {
  return provider.qualityScore * 2 - provider.latencyScore - provider.costScore
}
