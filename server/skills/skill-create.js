import { createHash } from 'node:crypto'
import { registerTool } from '../tools/registry.js'
import { parseSkillMarkdown } from './loader.js'
import { writeSkillFromAgent } from './service.js'

export function registerSkillCreateTool() {
  return registerTool({
    id: 'skill_create',
    description: 'Validate and install one Markdown-only skill in the requesting user’s personal skills folder.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        markdown: { type: 'string', minLength: 1, maxLength: 32768 },
      },
      required: ['name', 'markdown'],
      additionalProperties: false,
    },
    permissions: ['tool:approved'],
    requiresApproval: true,
    retrySafe: false,
    auditDetails: (input) => {
      const skill = parseSkillMarkdown(input.markdown)
      return {
        name: skill.name,
        version: skill.version,
        bytes: Buffer.byteLength(input.markdown, 'utf8'),
        sha256: createHash('sha256').update(input.markdown).digest('hex'),
      }
    },
    validate: (input) => {
      if (typeof input?.name !== 'string' || typeof input.markdown !== 'string') return false
      try {
        const skill = parseSkillMarkdown(input.markdown)
        return skill.name === input.name && skill.name !== 'create-skill'
      } catch {
        return false
      }
    },
    execute: ({ input, userId, database }) => writeSkillFromAgent({
      userId,
      markdown: input.markdown,
      database,
    }),
    verifyResult: (result) => Boolean(result &&
      typeof result.name === 'string' &&
      ((result.status === 'installed' && typeof result.version === 'string') ||
        (result.status === 'pending_approval' && typeof result.approval?.id === 'string'))),
  })
}
