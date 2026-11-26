const BARE_ACTION_WORDS = new Set([
  'can', 'could', 'do', 'for', 'it', 'linkedin', 'me', 'now', 'on', 'please', 'post',
  'publish', 'right', 'share', 'the', 'this', 'to', 'today', 'you',
])

export function resolveLinkedInPostIntent(message, { history = [], pendingQuestion = null } = {}) {
  const current = normalizeText(message)
  if (!current) return null

  if (hasLinkedInAction(current)) {
    const text = extractExplicitPostText(current)
    if (text) return { kind: 'post', text }
    if (isBareLinkedInAction(current)) return { kind: 'missing_text', alreadyAsked: false }
    return { kind: 'compose' }
  }

  const previousUsers = history.filter((item) => item?.role === 'user' && normalizeText(item.content))
  const pendingRequest = normalizeText(pendingQuestion?.previousUserMessage)
  const hasLinkedInContext = hasLinkedInAction(pendingRequest) ||
    history.filter((item) => item?.role === 'user')
      .slice(-3)
      .some((item) => hasLinkedInAction(item.content)) ||
    /\blinkedin\b/i.test(pendingQuestion?.question || '')

  if (isLinkedInTextQuestion(pendingQuestion?.question) && hasLinkedInContext) {
    if (isAcknowledgement(current)) {
      const previousText = findRecentPostText(history) ||
        extractExplicitPostText(pendingRequest) ||
        findPriorUserText(previousUsers, pendingRequest)
      return previousText
        ? { kind: 'post', text: previousText }
        : { kind: 'missing_text', alreadyAsked: true }
    }
    return { kind: 'post', text: current }
  }

  if (hasLinkedInContext && isLinkedInApprovalQuestion(pendingQuestion?.question) && isAcknowledgement(current)) {
    const previousText = findRecentPostText(history) ||
      extractExplicitPostText(pendingRequest) ||
      findPriorUserText(previousUsers)
    if (previousText) return { kind: 'post', text: previousText }
  }

  if (isPostReference(current)) {
    if (/^(?:please\s+)?send\s+(?:it|this|that)[.!? ]*$/i.test(current) && !hasLinkedInContext) return null
    const previousText = findPriorUserText(previousUsers) || findRecentPostText(history)
    if (previousText) return { kind: 'post', text: previousText }
  }

  return null
}

function hasLinkedInAction(value) {
  const text = normalizeText(value)
  if (!text || /\b(?:do not|don't|never)\s+(?:post|publish|share)\b/i.test(text)) return false
  return /\b(?:post|publish|share)\b[\s\S]{0,100}\blinkedin\b/i.test(text) ||
    /\blinkedin\b[\s\S]{0,100}\b(?:post|publish|share)\b/i.test(text)
}

function extractExplicitPostText(value) {
  const text = normalizeText(value)
  if (!hasLinkedInAction(text)) return null
  const linkedIn = /\blinkedin\b/i.exec(text)
  let separator = text.indexOf(':', linkedIn.index + linkedIn[0].length)
  while (separator >= 0 && /\d/.test(text[separator - 1] || '') && /\d/.test(text[separator + 1] || '')) {
    separator = text.indexOf(':', separator + 1)
  }
  if (separator < 0) return null
  return normalizeText(text.slice(separator + 1)) || null
}

function isBareLinkedInAction(value) {
  const words = normalizeText(value).toLowerCase().match(/[a-z0-9]+/g) || []
  return words.every((word) => BARE_ACTION_WORDS.has(word))
}

function isLinkedInTextQuestion(value) {
  return typeof value === 'string' && /\bwhat\b.{0,50}\btext\b.{0,50}\bpost\b/i.test(value)
}

function isLinkedInApprovalQuestion(value) {
  return typeof value === 'string' && /\b(?:approve|approval|approved|exact text)\b/i.test(value)
}

function isAcknowledgement(value) {
  return /^(?:yes(?:,?\s+i approve)?|yeah|yep|approved|approve|i approve|post it now|do it|send it)[.! ]*$/i.test(value)
}

function isPostReference(value) {
  return /^(?:please\s+)?(?:post|publish|share|send)\s+(?:it|this|that)(?:\s+(?:now|please))?[.!? ]*$/i.test(value)
}

function findRecentPostText(history) {
  for (const item of [...history].reverse()) {
    if (item?.role !== 'user') continue
    const text = extractExplicitPostText(item.content)
    if (text) return text
  }
  return null
}

function findPriorUserText(previousUsers, excludedMessage = '') {
  for (const previous of [...previousUsers].reverse()) {
    const text = normalizeText(previous.content)
    if (!text || text === excludedMessage || hasLinkedInAction(text) ||
      isPostReference(text) || isAcknowledgement(text)) continue
    return text
  }
  return null
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}
