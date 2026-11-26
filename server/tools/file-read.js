import { readFile } from 'node:fs/promises'
import { config } from '../config.js'
import { registerTool } from './registry.js'
import { isValidWorkspacePath, MAX_WORKSPACE_FILE_BYTES, resolveWorkspaceTarget } from './workspace.js'

export function registerFileReadTool({ workspaceDir = config.workspaceDir } = {}) {
  return registerTool({
    id: 'file_read',
    description: 'Read a UTF-8 text file inside the current user workspace. Secret paths and symbolic links are blocked.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } },
      required: ['path'],
      additionalProperties: false,
    },
    permissions: ['tool:read'],
    readOnly: true,
    requiresApproval: false,
    retrySafe: true,
    validate: (input) => typeof input?.path === 'string' &&
      input.path.trim().length > 0 &&
      input.path.length <= 1024 &&
      isValidWorkspacePath(input.path),
    auditDetails: (input) => ({ path: input.path }),
    execute: async ({ input, userId }) => {
      const target = await resolveWorkspaceTarget({ workspaceDir, userId, relativePath: input.path })
      if (!target.stat.isFile()) {
        throw Object.assign(new Error('The requested workspace path is not a file.'), { status: 400 })
      }
      if (target.stat.size > MAX_WORKSPACE_FILE_BYTES) {
        throw Object.assign(new Error(`Workspace files must be ${MAX_WORKSPACE_FILE_BYTES} bytes or smaller.`), { status: 413 })
      }
      const buffer = await readFile(target.path)
      if (buffer.includes(0)) {
        throw Object.assign(new Error('Binary files cannot be read as text.'), { status: 415 })
      }
      let content
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch (cause) {
        throw Object.assign(new Error('The workspace file is not valid UTF-8 text.', { cause }), { status: 415 })
      }
      return { path: target.relativePath, bytes: buffer.length, content }
    },
    verifyResult: (result) => Boolean(result &&
      typeof result.path === 'string' &&
      typeof result.content === 'string' &&
      Number.isInteger(result.bytes)),
  })
}
