import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { registerTool } from './registry.js'
import { isValidWorkspacePath, MAX_WORKSPACE_LIST_ENTRIES, isSensitiveWorkspacePath, resolveWorkspaceTarget } from './workspace.js'

export function registerFileListTool({ workspaceDir = config.workspaceDir } = {}) {
  return registerTool({
    id: 'file_list',
    description: 'List files and folders inside the current user workspace. Secret paths and symbolic links are omitted.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', maxLength: 1024 } },
      additionalProperties: false,
    },
    permissions: ['tool:read'],
    readOnly: true,
    requiresApproval: false,
    retrySafe: true,
    validate: (input) => input?.path === undefined ||
      (typeof input.path === 'string' &&
        input.path.length <= 1024 &&
        isValidWorkspacePath(input.path, { allowRoot: true })),
    auditDetails: (input) => ({ path: input.path || '.' }),
    execute: async ({ input, userId }) => {
      const target = await resolveWorkspaceTarget({
        workspaceDir,
        userId,
        relativePath: input.path || '',
        allowRoot: true,
      })
      if (!target.stat.isDirectory()) {
        throw Object.assign(new Error('The requested workspace path is not a directory.'), { status: 400 })
      }
      const entries = await readdir(target.path, { withFileTypes: true })
      const visible = entries
        .filter((entry) => !entry.isSymbolicLink() && !isSensitiveWorkspacePath(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
      const items = await Promise.all(visible.slice(0, MAX_WORKSPACE_LIST_ENTRIES).map(async (entry) => {
        const entryPath = `${target.relativePath ? `${target.relativePath}/` : ''}${entry.name}`
        const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
        return {
          name: entry.name,
          path: entryPath,
          kind,
          ...(kind === 'file' ? { bytes: (await lstat(path.join(target.path, entry.name))).size } : {}),
        }
      }))
      return {
        path: target.relativePath || '.',
        entries: items,
        truncated: visible.length > MAX_WORKSPACE_LIST_ENTRIES,
      }
    },
    verifyResult: (result) => Boolean(result &&
      typeof result.path === 'string' &&
      Array.isArray(result.entries) &&
      result.entries.every((entry) => typeof entry.name === 'string' && ['directory', 'file', 'other'].includes(entry.kind))),
  })
}
