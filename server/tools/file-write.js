import { createHash } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { registerTool } from './registry.js'
import { createWorkspaceTemporaryPath, getWorkspaceApprovalScope, isValidWorkspacePath, MAX_WORKSPACE_FILE_BYTES, prepareWorkspaceWriteTarget } from './workspace.js'

export function registerFileWriteTool({ workspaceDir = config.workspaceDir } = {}) {
  return registerTool({
    id: 'file_write',
    description: 'Create or replace a UTF-8 text file inside the current user workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1024 },
        content: { type: 'string', maxLength: MAX_WORKSPACE_FILE_BYTES },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    permissions: ['tool:approved'],
    requiresApproval: true,
    retrySafe: false,
    approvalScope: getWorkspaceApprovalScope(workspaceDir),
    describeAction: (input) => `Write ${input.path} (${Buffer.byteLength(input.content, 'utf8')} bytes) in this workspace.`,
    auditDetails: (input) => ({
      path: input.path,
      bytes: Buffer.byteLength(input.content, 'utf8'),
      sha256: createHash('sha256').update(input.content).digest('hex'),
    }),
    validate: (input) => typeof input?.path === 'string' &&
      input.path.trim().length > 0 &&
      input.path.length <= 1024 &&
      isValidWorkspacePath(input.path) &&
      typeof input.content === 'string' &&
      Buffer.byteLength(input.content, 'utf8') <= MAX_WORKSPACE_FILE_BYTES,
    execute: async ({ input, userId }) => {
      const target = await prepareWorkspaceWriteTarget({
        workspaceDir,
        userId,
        relativePath: input.path,
      })
      const parent = path.dirname(target.path)
      const temporaryPath = createWorkspaceTemporaryPath(parent)
      try {
        await writeFile(temporaryPath, input.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await rename(temporaryPath, target.path)
      } catch (error) {
        await rm(temporaryPath, { force: true })
        throw error
      }
      const bytes = Buffer.byteLength(input.content, 'utf8')
      return {
        path: target.relativePath,
        bytes,
        sha256: createHash('sha256').update(input.content).digest('hex'),
        action: target.exists ? 'updated' : 'created',
      }
    },
    verifyResult: (result) => Boolean(result &&
      typeof result.path === 'string' &&
      Number.isInteger(result.bytes) &&
      /^[a-f0-9]{64}$/.test(result.sha256) &&
      ['created', 'updated'].includes(result.action)),
  })
}
