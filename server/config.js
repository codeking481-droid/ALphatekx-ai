import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const isProduction = process.env.NODE_ENV === 'production'
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webOrigin = process.env.WEB_ORIGIN || (isProduction ? 'https://alphatekx-ai.pages.dev' : 'http://localhost:5173')
const authUrl = process.env.BETTER_AUTH_URL || (
  isProduction ? 'https://alphatekx-ai.pages.dev' : `http://localhost:${process.env.PORT || 3001}`
)

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,
  port: Number(process.env.PORT || 3001),
  webOrigin: new URL(webOrigin).origin,
  trustedOrigins: [...new Set([new URL(webOrigin).origin, new URL(authUrl).origin])],
  databaseUrl: process.env.DATABASE_URL,
  authSecret: process.env.BETTER_AUTH_SECRET,
  authUrl,
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  workspaceDir: path.resolve(projectRoot, process.env.WORKSPACE_DIR || 'workspace'),
  skillsDir: path.resolve(projectRoot, 'skills'),
  aiProvider: process.env.AI_PROVIDER?.trim().toLowerCase() ||
    (process.env.AI_PROVIDER_URL_1?.trim() ? 'worker1' : undefined),
  aiRequestTimeoutMs: Number(process.env.AI_REQUEST_TIMEOUT_MS || 60_000),
}

export function validateConfig() {
  const missing = []
  if (!config.databaseUrl) missing.push('DATABASE_URL')
  if (!config.authSecret || config.authSecret.length < 32) missing.push('BETTER_AUTH_SECRET (at least 32 characters)')
  if (samePath(config.workspaceDir, projectRoot) || samePath(config.workspaceDir, path.parse(config.workspaceDir).root)) {
    missing.push('WORKSPACE_DIR (a dedicated subdirectory, not the project or filesystem root)')
  }
  if (!Number.isInteger(config.aiRequestTimeoutMs) || config.aiRequestTimeoutMs < 1_000 || config.aiRequestTimeoutMs > 300_000) {
    missing.push('AI_REQUEST_TIMEOUT_MS (1000-300000)')
  }
  if (config.isProduction && !path.isAbsolute(config.uploadDir)) {
    missing.push('UPLOAD_DIR (an absolute persistent-volume path in production)')
  }
  if (missing.length) {
    throw new Error(`Missing or invalid server configuration: ${missing.join(', ')}`)
  }
}

export function validateWorkerConfig() {
  const missing = []
  if (!config.databaseUrl) missing.push('DATABASE_URL')
  if (samePath(config.workspaceDir, projectRoot) || samePath(config.workspaceDir, path.parse(config.workspaceDir).root)) {
    missing.push('WORKSPACE_DIR (a dedicated subdirectory, not the project or filesystem root)')
  }
  if (!Number.isInteger(config.aiRequestTimeoutMs) || config.aiRequestTimeoutMs < 1_000 || config.aiRequestTimeoutMs > 300_000) {
    missing.push('AI_REQUEST_TIMEOUT_MS (1000-300000)')
  }
  if (config.isProduction && !path.isAbsolute(config.uploadDir)) {
    missing.push('UPLOAD_DIR (an absolute persistent-volume path in production)')
  }
  if (missing.length) {
    throw new Error(`Missing or invalid worker configuration: ${missing.join(', ')}`)
  }
}

function samePath(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === ''
}
