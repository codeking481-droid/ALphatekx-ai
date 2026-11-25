const CAPABILITY_KEYS = [
  'textGeneration',
  'streaming',
  'structuredOutput',
  'toolCalling',
  'imageUnderstanding',
  'fileProcessing',
  'embeddings',
]

export function assertProviderContract(provider) {
  if (!provider?.id || !provider.name || typeof provider.generate !== 'function' ||
    typeof provider.discoverModels !== 'function' || typeof provider.isAvailable !== 'boolean') {
    throw new TypeError('An AI provider must define an id, name, availability, generation, and model discovery.')
  }
  for (const capability of CAPABILITY_KEYS) {
    if (typeof provider.capabilities?.[capability] !== 'boolean') {
      throw new TypeError(`Provider "${provider.id}" must explicitly declare ${capability} support.`)
    }
  }
  if (provider.capabilities.streaming && typeof provider.stream !== 'function') {
    throw new TypeError(`Provider "${provider.id}" declares streaming without implementing it.`)
  }
  return provider
}

export { CAPABILITY_KEYS }
