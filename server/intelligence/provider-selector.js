import { config } from '../config.js'
import {
  FALLBACK_PROVIDER_IDS,
  PRIMARY_PROVIDER_IDS,
  localFallbackProvider,
} from '../providers/fallback-chain.js'

export function selectProvider(registry, {
  preferred = config.aiProvider,
  exclude = [],
  capability = 'textGeneration',
} = {}) {
  const allProviders = registry.list()
  const hasPrimaryChain = allProviders.some((provider) => PRIMARY_PROVIDER_IDS.includes(provider.id))
  const candidates = allProviders
    .filter((provider) => provider.available && provider.capabilities?.[capability] && !exclude.includes(provider.id))
  if (!hasPrimaryChain && preferred) {
    const selected = candidates.find((provider) => provider.id === preferred)
    if (selected) return registry.get(selected.id)
  }
  const selected = hasPrimaryChain
    ? PRIMARY_PROVIDER_IDS.map((id) => candidates.find((provider) => provider.id === id)).find(Boolean) ||
      candidates.find((provider) => FALLBACK_PROVIDER_IDS.includes(provider.id))
    : candidates.sort((left, right) => providerScore(right) - providerScore(left))[0]
  if (!selected) return localFallbackProvider
  return registry.get(selected.id)
}

function providerScore(provider) {
  return provider.qualityScore * 2 - provider.latencyScore - provider.costScore
}
