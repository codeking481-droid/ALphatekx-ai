import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'

export const MAX_WORKSPACE_FILE_BYTES = 256 * 1024
export const MAX_WORKSPACE_LIST_ENTRIES = 200

const secretName = /(?:^|[._-])(?:secret|secrets|credential|credentials|token|password|private[_-]?key|api[_-]?keys?)(?:$|[._-])/i
const secretExtension = /\.(?:pem|key|p12|pfx|jks|keystore)$/i
const blockedNames = new Set(['.git', '.aws', '.ssh', '.npmrc', '.pypirc', 'id_rsa', 'id_ecdsa', 'id_ed25519'])

export function getWorkspaceApprovalScope(workspaceDir) {
  const resolved = path.resolve(workspaceDir)
  return `workspace:${createHash('sha256').update(resolved.toLowerCase()).digest('hex')}`
}

export function isSensitiveWorkspacePath(relativePath) {
  return String(relativePath).split(/[\\/]+/).some((segment) => (
    /^\.env(?:$|\.)/i.test(segment) ||
    blockedNames.has(segment.toLowerCase()) ||
    secretName.test(segment) ||
    secretExtension.test(segment)
  ))
}

export function normalizeWorkspacePath(relativePath, { allowRoot = false } = {}) {
  if (typeof relativePath !== 'string' || relativePath.length > 1024 || relativePath.includes('\0')) {
    throw workspaceError('Workspace path must be a non-empty relative path.')
  }
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
    /^[a-z]:/i.test(relativePath) || relativePath.startsWith('\\\\')) {
    throw workspaceError('Absolute paths are not allowed in the workspace.')
  }
  const segments = relativePath.split(/[\\/]+/).filter(Boolean)
  if ((!allowRoot && !segments.length) || segments.some((segment) => (
    segment === '.' ||
    segment === '..' ||
    /[<>:"|?*]/.test(segment) ||
    /[. ]$/.test(segment)
  ))) {
    throw workspaceError('Workspace paths cannot contain traversal or unsupported path segments.')
  }
  if (isSensitiveWorkspacePath(segments.join('/'))) {
    throw workspaceError('Workspace paths that may contain secrets are not available.')
  }
  return segments
}

export function isValidWorkspacePath(relativePath, options) {
  try {
    normalizeWorkspacePath(relativePath, options)
    return true
  } catch {
    return false
  }
}

export async function resolveWorkspaceTarget({ workspaceDir, userId, relativePath, allowRoot = false }) {
  const segments = normalizeWorkspacePath(relativePath, { allowRoot })
  const root = await getUserWorkspaceRoot(workspaceDir, userId)
  let target = root
  let details = await lstat(target)
  for (let index = 0; index < segments.length; index += 1) {
    target = path.join(target, segments[index])
    assertWithin(root, target)
    try {
      details = await lstat(target)
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw workspaceError('The requested workspace path does not exist.', 404)
      }
      throw error
    }
    if (details.isSymbolicLink()) {
      throw workspaceError('Symbolic links are not available in the workspace.')
    }
    const resolved = await realpath(target)
    assertWithin(root, resolved)
    target = resolved
    if (index < segments.length - 1 && !details.isDirectory()) {
      throw workspaceError('A parent workspace path is not a directory.')
    }
  }
  return {
    path: target,
    root,
    relativePath: segments.join('/'),
    stat: details,
  }
}

export async function prepareWorkspaceWriteTarget({ workspaceDir, userId, relativePath }) {
  const segments = normalizeWorkspacePath(relativePath)
  const root = await getUserWorkspaceRoot(workspaceDir, userId)
  let parent = root
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(parent, segment)
    assertWithin(root, next)
    try {
      await mkdir(next)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const details = await lstat(next)
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw workspaceError('Workspace folders cannot contain symbolic links or non-directory parents.')
    }
    parent = await realpath(next)
    assertWithin(root, parent)
  }
  const target = path.join(parent, segments[segments.length - 1])
  assertWithin(root, target)
  let exists = false
  try {
    const details = await lstat(target)
    if (details.isSymbolicLink() || !details.isFile()) {
      throw workspaceError('The target must be a regular workspace file.')
    }
    exists = true
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return { path: target, root, relativePath: segments.join('/'), exists }
}

export function createWorkspaceTemporaryPath(parent) {
  return path.join(parent, `.alphatekx-${randomUUID()}.tmp`)
}

async function getUserWorkspaceRoot(workspaceDir, userId) {
  if (typeof userId !== 'string' || !userId.trim()) {
    throw workspaceError('A user identity is required for workspace access.', 403)
  }
  const configuredRoot = path.resolve(workspaceDir)
  await mkdir(configuredRoot, { recursive: true })
  const root = await realpath(configuredRoot)
  const usersPath = path.join(root, 'users')
  await mkdir(usersPath, { recursive: true })
  const usersDetails = await lstat(usersPath)
  if (usersDetails.isSymbolicLink() || !usersDetails.isDirectory()) {
    throw workspaceError('The workspace users folder is not a safe directory.', 403)
  }
  const usersRoot = await realpath(usersPath)
  assertWithin(root, usersRoot)
  const userHash = createHash('sha256').update(userId).digest('hex')
  const userPath = path.join(usersRoot, userHash)
  await mkdir(userPath, { recursive: true })
  const userDetails = await lstat(userPath)
  if (userDetails.isSymbolicLink() || !userDetails.isDirectory()) {
    throw workspaceError('The user workspace is not a safe directory.', 403)
  }
  const userRoot = await realpath(userPath)
  assertWithin(usersRoot, userRoot)
  return userRoot
}

function assertWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw workspaceError('The requested path escapes the workspace.', 403)
  }
}

function workspaceError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}
