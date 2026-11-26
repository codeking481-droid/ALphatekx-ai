const MOTION_GRAPHICS_TERMS = /\b(?:motion graphics?|animation|animated intro|logo animation|animated text)\b/i
const CREATION_ACTIONS = /\b(?:make|create|generate|design|build|animate|produce)\b/i
const REGENERATION_TERMS = /\b(?:different|another|new|regenerate|variation|variant)\b/i
const MOTION_PREVIEW_LINK = /\/api\/files\/[a-f0-9-]{36}(?:\/preview)?/i

export function isMotionGraphicsRegeneration(message, history = []) {
  if (typeof message !== 'string' || !REGENERATION_TERMS.test(message)) return false
  return history.some((item) =>
    item?.role === 'assistant' &&
    typeof item.content === 'string' &&
    MOTION_PREVIEW_LINK.test(item.content))
}

export function isMotionGraphicsRequest(message, history = []) {
  if (typeof message !== 'string') return false
  return (MOTION_GRAPHICS_TERMS.test(message) && CREATION_ACTIONS.test(message)) ||
    isMotionGraphicsRegeneration(message, history)
}
