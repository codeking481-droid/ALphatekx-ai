import { getLinkedInComments, publishLinkedInPost, publishLinkedInReply, searchLinkedInPeople } from './service.js'
import { registerTool } from '../tools/registry.js'

const postTextSchema = {
  type: 'object',
  properties: { text: { type: 'string', minLength: 1, maxLength: 3000 } },
  required: ['text'],
  additionalProperties: false,
}

export function registerLinkedInTools() {
  return [
    registerTool({
      id: 'linkedin_post',
      name: 'Publish LinkedIn Post',
      connector: 'linkedin',
      description: 'Publish the exact LinkedIn post text only after the user approves it in Approvals.',
      inputSchema: postTextSchema,
      permissions: ['tool:approved'],
      requiresApproval: true,
      retrySafe: false,
      timeoutMs: 30_000,
      validate: (input) => typeof input?.text === 'string' && input.text.trim().length > 0 && input.text.length <= 3000,
      describeAction: (input) => `Publish this LinkedIn post:\n\n${input.text.trim()}`,
      auditDetails: (input) => ({ characters: input.text.trim().length }),
      execute: ({ input, userId, database }) => publishLinkedInPost({
        userId,
        text: input.text,
        database,
      }),
      verifyResult: (result) => Boolean(result?.posted === true && result.preview === false),
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
