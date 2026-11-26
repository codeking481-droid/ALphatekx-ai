import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

const tools = new Map()
const scopedTools = new AsyncLocalStorage()

export function registerTool(tool) {
  if (typeof tool?.id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(tool.id) ||
    typeof tool.description !== 'string' || !tool.description.trim() ||
    (tool.name !== undefined && (typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 100)) ||
    (tool.connector !== undefined && (typeof tool.connector !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(tool.connector))) ||
    !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema) ||
    typeof tool.execute !== 'function' ||
    (tool.requiresApproval !== undefined && typeof tool.requiresApproval !== 'boolean') ||
    (tool.readOnly !== undefined && typeof tool.readOnly !== 'boolean') ||
    (tool.retrySafe !== undefined && typeof tool.retrySafe !== 'boolean') ||
    (tool.timeoutMs !== undefined && (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 1 || tool.timeoutMs > 300000)) ||
    (tool.verifyResult !== undefined && typeof tool.verifyResult !== 'function') ||
    (tool.describeAction !== undefined && typeof tool.describeAction !== 'function') ||
    (tool.auditDetails !== undefined && typeof tool.auditDetails !== 'function') ||
    (tool.normalizeInput !== undefined && typeof tool.normalizeInput !== 'function') ||
    (tool.approvalScope !== undefined && (typeof tool.approvalScope !== 'string' || !tool.approvalScope.trim() || tool.approvalScope.length > 512)) ||
    typeof tool.validate !== 'function' || !Array.isArray(tool.permissions) || !tool.permissions.length ||
    tool.permissions.some((permission) => typeof permission !== 'string' || !permission)) {
    throw new TypeError('A tool requires an id, input schema, validator, permissions, and execute function.')
  }
  let inputSchema
  try {
    inputSchema = JSON.parse(JSON.stringify(tool.inputSchema))
  } catch (cause) {
    throw new TypeError('A tool input schema must be JSON serializable.', { cause })
  }
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new TypeError('A tool input schema must be a JSON object.')
  }
  freezeDeep(inputSchema)
  if (tools.has(tool.id)) throw new Error(`Tool "${tool.id}" is already registered.`)
  tools.set(tool.id, Object.freeze({
    ...tool,
    name: tool.name?.trim() || humanizeToolId(tool.id),
    connector: tool.connector || 'builtin',
    inputSchema,
    permissions: Object.freeze([...tool.permissions]),
    requiresApproval: tool.requiresApproval !== false,
    readOnly: tool.readOnly === true,
    retrySafe: tool.retrySafe === true,
    timeoutMs: tool.timeoutMs || 30000,
  }))
  return () => tools.delete(tool.id)
}

function humanizeToolId(id) {
  return id.split(/[._-]+/).filter(Boolean).map((part) =>
    part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

export function getTool(id) {
  return scopedTools.getStore()?.get(id) || tools.get(id)
}

export function listTools() {
  const available = new Map(tools)
  for (const [id, tool] of scopedTools.getStore() || []) available.set(id, tool)
  return [...available.values()].map(({ execute, validate, verifyResult, describeAction, auditDetails, normalizeInput, approvalScope, ...tool }) => tool)
}

export function withScopedTools(toolsForScope, operation) {
  const current = new Map(scopedTools.getStore() || [])
  for (const tool of toolsForScope) {
    if (current.has(tool.id) || tools.has(tool.id)) throw new Error(`Tool "${tool.id}" is already registered in this scope.`)
    current.set(tool.id, tool)
  }
  return scopedTools.run(current, operation)
}

export function getToolActionFingerprint(tool, input) {
  if (!tool || typeof tool.id !== 'string') throw new TypeError('An action fingerprint requires a registered tool.')
  return createHash('sha256')
    .update(stableJson({
      id: tool.id,
      version: tool.version || null,
      description: tool.description,
      inputSchema: tool.inputSchema,
      permissions: tool.permissions,
      requiresApproval: tool.requiresApproval,
      approvalScope: tool.approvalScope || null,
      retrySafe: tool.retrySafe,
      execute: tool.execute.toString(),
      validate: tool.validate.toString(),
      verifyResult: tool.verifyResult?.toString() || null,
      describeAction: tool.describeAction?.toString() || null,
      auditDetails: tool.auditDetails?.toString() || null,
      normalizeInput: tool.normalizeInput?.toString() || null,
      input,
    }))
    .digest('hex')
}

export function parseApprovalDescription(value) {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed.description === 'string' && typeof parsed.fingerprint === 'string') {
      return parsed
    }
  } catch {
    return null
  }
  return null
}

export function serializeApprovalDescription(tool, input) {
  const description = tool.describeAction
    ? tool.describeAction(input)
    : `${tool.name}:\n${JSON.stringify(redactApprovalInput(input), null, 2)}`
  if (typeof description !== 'string' || !description.trim()) {
    throw new TypeError(`Tool "${tool.id}" produced an invalid approval description.`)
  }
  return JSON.stringify({
    description,
    fingerprint: getToolActionFingerprint(tool, input),
  })
}

function redactApprovalInput(value) {
  if (Array.isArray(value)) return value.map(redactApprovalInput)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /(?:token|secret|password|api[_-]?key|authorization|cookie)/i.test(key)
      ? '[redacted]'
      : redactApprovalInput(item),
  ]))
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freezeDeep(child)
  return Object.freeze(value)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
