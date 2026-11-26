import { getLinkedInComments, publishLinkedInPost, publishLinkedInReply, searchLinkedInPeople, validatePostSchedule } from './service.js'
import { registerTool } from '../tools/registry.js'

const postInputSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 3000 },
    schedule: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['scheduled', 'recurring'] },
        scheduledAt: { type: 'string', minLength: 1, maxLength: 40 },
        timezone: { type: 'string', minLength: 1, maxLength: 100 },
        count: { type: 'integer', minimum: 2, maximum: 30 },
        intervalMinutes: { type: 'integer', minimum: 1440, maximum: 43200 },
        sameText: { type: 'boolean' },
        texts: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 3000 } },
      },
      required: ['mode', 'scheduledAt', 'timezone'],
      additionalProperties: false,
    },
  },
  required: ['text'],
  additionalProperties: false,
}

export function registerLinkedInTools() {
  return [
    registerTool({
      id: 'linkedin_post',
      name: 'Publish LinkedIn Post',
      connector: 'linkedin',
      description: 'Publish or schedule LinkedIn post text only after the user approves the exact text and schedule in Approvals. For a schedule, preserve the parsed timezone and time; recurring schedules require a text reuse choice.',
      inputSchema: postInputSchema,
      permissions: ['tool:approved'],
      requiresApproval: true,
      retrySafe: false,
      timeoutMs: 30_000,
      normalizeInput: (input, { scheduleIntent, linkedinPostText } = {}) => {
        const normalized = { ...input }
        if (typeof linkedinPostText === 'string' &&
          !(scheduleIntent?.mode === 'recurring' && scheduleIntent.sameText === false)) {
          normalized.text = linkedinPostText
        }
        if (scheduleIntent?.mode === 'now') {
          delete normalized.schedule
          return normalized
        }
        if (!['scheduled', 'recurring'].includes(scheduleIntent?.mode) ||
          typeof scheduleIntent.scheduledAt !== 'string' ||
          typeof scheduleIntent.timezone !== 'string') {
          return normalized
        }
        const schedule = {
          mode: scheduleIntent.mode,
          scheduledAt: scheduleIntent.scheduledAt,
          timezone: scheduleIntent.timezone,
        }
        if (scheduleIntent.mode === 'recurring') {
          Object.assign(schedule, {
            count: scheduleIntent.count,
            intervalMinutes: scheduleIntent.intervalMinutes,
            sameText: scheduleIntent.sameText,
          })
          if (scheduleIntent.sameText === false && Array.isArray(normalized.schedule?.texts)) {
            schedule.texts = normalized.schedule.texts
          }
        }
        return { ...normalized, schedule }
      },
      validate: (input) => {
        if (typeof input?.text !== 'string' || input.text.trim().length === 0 || input.text.length > 3000) return false
        if (input.schedule === undefined) return true
        try {
          validatePostSchedule(input.schedule)
          return true
        } catch {
          return false
        }
      },
      describeAction: (input) => `${input.schedule ? 'Schedule' : 'Publish'} this LinkedIn post:\n\n${input.text.trim()}${input.schedule ? `\n\nSchedule:\n${JSON.stringify(input.schedule, null, 2)}` : ''}`,
      auditDetails: (input) => ({ characters: input.text.trim().length, schedule: input.schedule ? { mode: input.schedule.mode, count: input.schedule.count || 1, timezone: input.schedule.timezone } : null }),
      execute: ({ input, userId, database }) => publishLinkedInPost({
        userId,
        text: input.text,
        schedule: input.schedule || null,
        database,
      }),
      verifyResult: (result) => Boolean(
        result?.preview === false && (result.posted === true || result.scheduled === true),
      ),
    }),
    registerTool({
      id: 'linkedin_read_comments',
      name: 'Read LinkedIn Comments',
      connector: 'linkedin',
      description: 'Read comments on one LinkedIn post the connected account can access.',
      inputSchema: {
        type: 'object',
        properties: { postId: { type: 'string', minLength: 1, maxLength: 500 } },
        required: ['postId'],
        additionalProperties: false,
      },
      permissions: ['tool:read'],
      requiresApproval: false,
      retrySafe: true,
      timeoutMs: 30_000,
      validate: (input) => typeof input?.postId === 'string' && input.postId.length <= 500,
      auditDetails: (input) => ({ postId: input.postId }),
      execute: ({ input, userId, database }) => getLinkedInComments({
        userId,
        postId: input.postId,
        database,
      }),
      verifyResult: (result) => Boolean(result && Array.isArray(result.items)),
    }),
    registerTool({
      id: 'linkedin_reply',
      name: 'Reply to LinkedIn Comment',
      connector: 'linkedin',
      description: 'Reply to a LinkedIn comment; the exact reply requires user approval in Approvals.',
      inputSchema: {
        type: 'object',
        properties: {
          commentId: { type: 'string', minLength: 1, maxLength: 500 },
          text: { type: 'string', minLength: 1, maxLength: 3000 },
        },
        required: ['commentId', 'text'],
        additionalProperties: false,
      },
      permissions: ['tool:approved'],
      requiresApproval: true,
      retrySafe: false,
      timeoutMs: 30_000,
      validate: (input) => typeof input?.commentId === 'string' &&
        input.commentId.length <= 500 &&
        typeof input.text === 'string' &&
        input.text.trim().length > 0 &&
        input.text.length <= 3000,
      describeAction: (input) => `Reply to LinkedIn comment ${input.commentId} with:\n\n${input.text.trim()}`,
      auditDetails: (input) => ({ commentId: input.commentId, characters: input.text.trim().length }),
      execute: ({ input, userId, database }) => publishLinkedInReply({
        userId,
        commentId: input.commentId,
        text: input.text,
        database,
      }),
      verifyResult: (result) => Boolean(result?.posted === true && result.preview === false),
    }),
    registerTool({
      id: 'linkedin_search_people',
      name: 'Search LinkedIn People',
      connector: 'linkedin',
      description: 'Search LinkedIn people by keywords using the connected account, subject to LinkedIn API access.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
        required: ['query'],
        additionalProperties: false,
      },
      permissions: ['tool:read'],
      requiresApproval: false,
      retrySafe: true,
      timeoutMs: 30_000,
      validate: (input) => typeof input?.query === 'string' && input.query.trim().length > 0 && input.query.length <= 200,
      auditDetails: (input) => ({ query: input.query.trim() }),
      execute: ({ input, userId, database }) => searchLinkedInPeople({
        userId,
        query: input.query,
        database,
      }),
      verifyResult: (result) => Boolean(result && Array.isArray(result.items)),
    }),
  ]
}
