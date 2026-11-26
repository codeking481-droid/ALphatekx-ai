export function parseScheduleIntent(message, {
  timezone = 'UTC',
  now = new Date(),
  latestMessage = message,
} = {}) {
  if (typeof message !== 'string' || !/\b(post|publish|linkedin)\b/i.test(message)) return null
  const text = message.toLowerCase()
  const zone = validTimezone(timezone)
  if (/\b(only now|right now|immediately)\b/i.test(latestMessage || '')) {
    return { mode: 'now', timezone: zone }
  }
  const durationDays = parseDurationDays(text)
  const requestedCount = Number(/\b(\d+) posts?\s*(?:total|this week|per week)\b/.exec(text)?.[1]) || null
  const dailyCadence = /\b(every day|daily)\b/.test(text)
  const explicitDateRange = parseExplicitDateRange(message, now, zone)
  const recurring = dailyCadence ||
    /\b(every week|weekly|recurring|next week|for one week|for a week|for \d+ days?)\b/i.test(text) ||
    Boolean(requestedCount || explicitDateRange?.count)

  if (recurring) {
    if (durationDays && !dailyCadence && !requestedCount) {
      return {
        mode: 'recurring',
        timezone: zone,
        clarificationQuestion: 'How many posts per week, and what time each day? Example: 1 per day at 9am, or 3 posts total?',
      }
    }
    const count = requestedCount || (dailyCadence ? durationDays || explicitDateRange?.count || 0 : explicitDateRange?.count || null)
    if (!count) {
      return {
        mode: 'recurring',
        timezone: zone,
        clarificationQuestion: 'How many posts per week, and what time each day? Example: 1 per day at 9am, or 3 posts total?',
      }
    }
    if (count === 1) {
      const time = parseClockTime(latestMessage) || parseClockTime(text)
      if (!time) {
        return {
          mode: 'scheduled',
          timezone: zone,
          clarificationQuestion: 'What day and time should I schedule the post?',
        }
      }
      const [hour, minute] = time.split(':').map(Number)
      return {
        mode: 'scheduled',
        scheduledAt: nextOccurrenceAtLocalTime(now, hour, minute, zone),
        timezone: zone,
      }
    }
    const intervalMinutes = durationDays && requestedCount && !dailyCadence
      ? Math.max(1, Math.round((durationDays - 1) / (requestedCount - 1))) * 1440
      : 1440
    const time = parseClockTime(latestMessage) || parseClockTime(text)
    if (!time) {
      return {
        mode: 'recurring',
        count,
        intervalMinutes,
        timezone: zone,
        clarificationQuestion: 'What time should I schedule each post?',
      }
    }
    if (!/\b(same text(?:\s+\d+\s+times?)?|reuse (?:the )?same|repeat (?:the )?same|different versions|different posts|unique posts)\b/i.test(text)) {
      return {
        mode: 'recurring',
        count,
        intervalMinutes,
        time,
        timezone: zone,
        clarificationQuestion: `Should I use the same text ${count} times, or make ${count} different versions?`,
      }
    }
    const timeParts = time.split(':').map(Number)
    const scheduledAt = explicitDateRange?.start
      ? dateAtLocalTime(explicitDateRange.start, timeParts[0], timeParts[1], zone, now)
      : /\b(?:start|starting|begin|from)\s+tomorrow\b/i.test(latestMessage || '')
        ? nextDayAtLocalTime(now, timeParts[0], timeParts[1], zone)
      : nextOccurrenceAtLocalTime(now, timeParts[0], timeParts[1], zone)
    return {
      mode: 'recurring',
      count,
      intervalMinutes,
      time,
      timezone: zone,
      scheduledAt,
      sameText: getLastTextReuseChoice(text) !== 'different',
    }
  }

  if (/\b(now|right now|immediately)\b/i.test(text) || /\btoday\b/i.test(text) && !parseClockTime(text)) {
    return { mode: 'now', timezone: zone }
  }
  if (/\b(in \d+ hours?|in \d+ minutes?|tomorrow|today)\b/i.test(text)) {
    const scheduledAt = parseOneTime(text, zone, now)
    if (scheduledAt && /\btoday\b/.test(text) && Date.parse(scheduledAt) <= now.getTime() + 60_000) {
      return {
        mode: 'scheduled',
        timezone: zone,
        clarificationQuestion: 'That time has already passed today. Should I schedule it for tomorrow or post now?',
      }
    }
    if (scheduledAt) return { mode: 'scheduled', scheduledAt, timezone: zone }
  }
  return null
}

export function createScheduleOccurrences({ startAt, scheduledAt, count, intervalMinutes, timezone }) {
  const start = new Date(startAt || scheduledAt)
  if (!Number.isFinite(start.getTime()) || !Number.isInteger(count) || count < 1 || count > 30 ||
    !Number.isInteger(intervalMinutes) || intervalMinutes < 1440 || intervalMinutes % 1440 !== 0) {
    throw new Error('The recurring schedule is invalid.')
  }
  let zone
  try {
    zone = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone
  } catch {
    throw new Error('The recurring schedule timezone is invalid.')
  }
  const first = zonedParts(start, zone)
  return Array.from({ length: count }, (_value, index) => {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + index * intervalMinutes / 1440))
    return localTimeToUtc({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: first.hour,
      minute: first.minute,
    }, zone).toISOString()
  })
}

function parseDurationDays(text) {
  if (/\b(this week|next week)\b/.test(text)) return 7
  const numeric = /\bfor (\d+) days?\b/.exec(text)
  if (numeric) return Math.min(30, Math.max(1, Number(numeric[1])))
  if (/\bfor (one|a) week\b/.test(text)) return 7
  if (/\bfor two weeks\b/.test(text)) return 14
  return null
}

function parseExplicitDateRange(text, now, timezone) {
  const matches = [...String(text || '').matchAll(
    /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,?\s+(20\d{2}))?\b/gi,
  )]
  if (!matches.length) return null
  const monthNumbers = new Map([
    ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
    ['jul', 7], ['aug', 8], ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
  ])
  const current = zonedParts(now, timezone)
  const parseDate = (match, reference = null) => {
    const month = monthNumbers.get(match[1].slice(0, 3).toLowerCase())
    const day = Number(match[2])
    let year = Number(match[3]) || reference?.year || current.year
    if (!match[3] && !reference && (month < current.month || (month === current.month && day < current.day))) {
      year += 1
    }
    if (!match[3] && reference && month < reference.month) year += 1
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
    return { year, month, day }
  }
  const start = parseDate(matches[0])
  if (!start) return null
  const end = matches.length > 1 ? parseDate(matches[matches.length - 1], start) : null
  let count = null
  if (end) {
    const firstDay = Date.UTC(start.year, start.month - 1, start.day)
    const lastDay = Date.UTC(end.year, end.month - 1, end.day)
    const days = Math.round((lastDay - firstDay) / 86_400_000) + 1
    if (days > 0 && days <= 30) count = days
  }
  return { start, count }
}

function dateAtLocalTime(date, hour, minute, timezone, now) {
  let target = localTimeToUtc({ ...date, hour, minute }, timezone)
  const current = zonedParts(now, timezone)
  if (date.year === current.year && date.month === current.month && date.day === current.day && target <= now) {
    const nextDay = new Date(Date.UTC(date.year, date.month - 1, date.day + 1))
    target = localTimeToUtc({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour,
      minute,
    }, timezone)
  }
  return target.toISOString()
}

function parseClockTime(text) {
  const match = /\b(?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text)
  if (!match) return null
  let hour = Number(match[1]) % 12
  if (match[3].toLowerCase() === 'pm') hour += 12
  const minute = Number(match[2] || 0)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function getLastTextReuseChoice(text) {
  const sameTextMatches = [...text.matchAll(/\b(?:same text(?:\s+\d+\s+times?)?|reuse (?:the )?same|repeat (?:the )?same)\b/gi)]
  const differentTextMatches = [...text.matchAll(/\b(?:different versions|different posts|unique posts)\b/gi)]
  const lastSame = sameTextMatches.at(-1)?.index ?? -1
  const lastDifferent = differentTextMatches.at(-1)?.index ?? -1
  return lastDifferent > lastSame ? 'different' : 'same'
}

function parseOneTime(text, timezone, now) {
  const inMatch = /\bin (\d+) (hours?|minutes?)\b/.exec(text)
  if (inMatch) {
    const amount = Number(inMatch[1]) * (inMatch[2].startsWith('hour') ? 60 : 1)
    return new Date(now.getTime() + amount * 60_000).toISOString()
  }
  const time = parseClockTime(text)
  if (!time) return null
  const current = zonedParts(now, timezone)
  const day = new Date(Date.UTC(current.year, current.month - 1, current.day + (/\btomorrow\b/.test(text) ? 1 : 0)))
  return localTimeToUtc({
    year: day.getUTCFullYear(),
    month: day.getUTCMonth() + 1,
    day: day.getUTCDate(),
    hour: Number(time.slice(0, 2)),
    minute: Number(time.slice(3)),
  }, timezone).toISOString()
}

function localTimeToUtc(parts, timezone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  let estimate = target
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedParts(new Date(estimate), timezone)
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
    estimate += target - actualUtc
  }
  return new Date(estimate)
}

function nextOccurrenceAtLocalTime(now, hour, minute, timezone) {
  const current = zonedParts(now, timezone)
  let date = new Date(Date.UTC(current.year, current.month - 1, current.day))
  let scheduled = localTimeToUtc({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour,
    minute,
  }, timezone)
  if (scheduled <= now) {
    date = new Date(date.getTime() + 86_400_000)
    scheduled = localTimeToUtc({
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour,
      minute,
    }, timezone)
  }
  return scheduled.toISOString()
}

function nextDayAtLocalTime(now, hour, minute, timezone) {
  const current = zonedParts(now, timezone)
  const next = new Date(Date.UTC(current.year, current.month - 1, current.day + 1))
  return localTimeToUtc({
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour,
    minute,
  }, timezone).toISOString()
}

function zonedParts(date, timezone) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(values.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, Number(value)]))
}

function validTimezone(value) {
  if (typeof value !== 'string' || value.length > 100) return 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return value
  } catch {
    return 'UTC'
  }
}
