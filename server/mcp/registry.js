import { createHash, randomUUID } from 'node:crypto'
import { decryptCredential, encryptCredential } from '../integrations/credential-vault.js'
import { syncToolDefinitions } from '../tools/sync.js'
import { validateJsonSchema } from '../tools/schema-validation.js'
import { withScopedTools } from '../tools/registry.js'
import { callMcpTool, listMcpTools, validateMcpHeaders, validateMcpUrl } from './client.js'

export async function withUserMcpTools({ userId, database }, operation) {
  const tools = await loadUserMcpTools({ userId, database })
  return withScopedTools(tools, async () => {
    await syncToolDefinitions(database)
    return operation()
  })
}

export async function loadUserMcpTools({ userId, database, callTool = callMcpTool }) {
  const { rows } = await database.query(
    `SELECT provider_id, encrypted_credentials, credential_key_version
     FROM integration_accounts WHERE user_id = $1 AND provider_id LIKE 'mcp:%'`,
    [userId],
  )
  return rows.flatMap((row) => {
    const server = JSON.parse(decryptCredential({
      value: row.encrypted_credentials,
      version: row.credential_key_version,
    }))
    if (!Array.isArray(server.tools)) return []
    return server.tools
      .filter((tool) => tool.enabled !== false)
      .map((tool) => createMcpTool(server, tool, callTool))
  })
}

export async function connectMcpServer({ userId, name, url, apiKey = '', headers = {}, database }) {
  const serverName = validateName(name)
  const secret = validateApiKey(apiKey)
  const safeHeaders = validateMcpHeaders(headers)
  const tools = await listMcpTools({ url, apiKey: secret, headers: safeHeaders })
  const serverId = randomUUID()
  const providerId = `mcp:${serverId}`
  const validatedUrl = await validateMcpUrl(url)
  const credentials = {
    serverId,
    name: serverName,
    url: validatedUrl.url.toString(),
    apiKey: secret,
    headers: safeHeaders,
    tools,
    connectionStatus: 'connected',
    lastError: null,
    lastTestedAt: new Date().toISOString(),
  }
  const sealed = encryptCredential(JSON.stringify(credentials))
  await database.query(
    `INSERT INTO integration_accounts (user_id, provider_id, encrypted_credentials, credential_key_version)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, provider_id) DO UPDATE SET encrypted_credentials = EXCLUDED.encrypted_credentials,
       credential_key_version = EXCLUDED.credential_key_version, updated_at = now()`,
    [userId, providerId, sealed.value, sealed.version],
  )
  return publicServer(credentials)
}

export async function listMcpServers({ userId, database }) {
  const servers = await readMcpServers({ userId, database })
  return servers.map(publicServer)
}

export async function refreshMcpServer({ userId, serverId, database }) {
  const server = await getMcpServer({ userId, serverId, database })
  let refreshedTools
  try {
    refreshedTools = await listMcpTools({ url: server.url, apiKey: server.apiKey, headers: server.headers })
  } catch (error) {
    const updated = {
      ...server,
      connectionStatus: 'failed',
      lastError: error.message || 'The server could not be reached.',
      lastTestedAt: new Date().toISOString(),
    }
    await storeMcpServer({ userId, serverId, credentials: updated, database })
    throw Object.assign(new Error(`${server.name}: ${updated.lastError}`), { status: 502, cause: error })
  }
  const previousTools = new Map((server.tools || []).map((tool) => [tool.name, tool.enabled !== false]))
  const tools = refreshedTools.map((tool) => ({ ...tool, enabled: previousTools.get(tool.name) ?? true }))
  const updated = {
    ...server,
    tools,
    connectionStatus: 'connected',
    lastError: null,
    lastTestedAt: new Date().toISOString(),
  }
  await storeMcpServer({ userId, serverId, credentials: updated, database })
  return publicServer(updated)
}

export async function getMcpServerTools({ userId, serverId, database }) {
  const server = await getMcpServer({ userId, serverId, database })
  let refreshedTools
  try {
    refreshedTools = await listMcpTools({ url: server.url, apiKey: server.apiKey, headers: server.headers })
  } catch (error) {
    const reason = error.message || 'The server could not be reached.'
    await storeMcpServer({
      userId,
      serverId,
      credentials: { ...server, connectionStatus: 'failed', lastError: reason, lastTestedAt: new Date().toISOString() },
      database,
    })
    throw Object.assign(new Error(`${server.name}: ${reason}`), { status: 502, cause: error })
  }
  const enabledByName = new Map((server.tools || []).map((tool) => [tool.name, tool.enabled !== false]))
  const tools = refreshedTools.map((tool) => ({ ...tool, enabled: enabledByName.get(tool.name) ?? true }))
  await storeMcpServer({
    userId,
    serverId,
    credentials: { ...server, tools, connectionStatus: 'connected', lastError: null, lastTestedAt: new Date().toISOString() },
    database,
  })
  return { items: tools.map(({ name, description, requiresApproval, enabled }) => ({ name, description, requiresApproval, enabled })) }
}

export async function setMcpToolEnabled({ userId, serverId, toolName, enabled, database }) {
  if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be a boolean.'), { status: 400 })
  const server = await getMcpServer({ userId, serverId, database })
  const tool = server.tools?.find((item) => item.name === toolName)
  if (!tool) throw Object.assign(new Error('MCP tool was not found. Refresh the server tools and try again.'), { status: 404 })
  tool.enabled = enabled
  await storeMcpServer({ userId, serverId, credentials: server, database })
  return { name: tool.name, enabled: tool.enabled }
}

export async function removeMcpServer({ userId, serverId, database }) {
  const result = await database.query(
    `DELETE FROM integration_accounts
     WHERE user_id = $1 AND provider_id = $2
     RETURNING provider_id`,
    [userId, `mcp:${validateServerId(serverId)}`],
  )
  return result.rowCount > 0
}

async function getMcpServer({ userId, serverId, database }) {
  const id = validateServerId(serverId)
  const { rows } = await database.query(
    `SELECT encrypted_credentials, credential_key_version
     FROM integration_accounts WHERE user_id = $1 AND provider_id = $2`,
    [userId, `mcp:${id}`],
  )
  if (!rows[0]) throw Object.assign(new Error('MCP server was not found in Connections.'), { status: 404 })
  return JSON.parse(decryptCredential({
    value: rows[0].encrypted_credentials,
    version: rows[0].credential_key_version,
  }))
}

async function readMcpServers({ userId, database }) {
  const { rows } = await database.query(
    `SELECT encrypted_credentials, credential_key_version
     FROM integration_accounts WHERE user_id = $1 AND provider_id LIKE 'mcp:%'
     ORDER BY created_at`,
    [userId],
  )
  return rows.map((row) => JSON.parse(decryptCredential({
    value: row.encrypted_credentials,
    version: row.credential_key_version,
  })))
}

async function storeMcpServer({ userId, serverId, credentials, database }) {
  const sealed = encryptCredential(JSON.stringify(credentials))
  await database.query(
    `UPDATE integration_accounts SET encrypted_credentials = $3, credential_key_version = $4, updated_at = now()
     WHERE user_id = $1 AND provider_id = $2`,
    [userId, `mcp:${serverId}`, sealed.value, sealed.version],
  )
}

function createMcpTool(server, tool, callTool) {
  const toolId = mcpToolId(server.serverId, tool.name)
  const requiredPermission = tool.requiresApproval ? 'tool:approved' : 'tool:read'
  return {
    id: toolId,
    name: `${server.name}: ${tool.name}`.slice(0, 100),
    connector: 'mcp',
    description: `${tool.description} (MCP server: ${server.name})`.slice(0, 2000),
    inputSchema: tool.inputSchema,
    permissions: [requiredPermission],
    requiresApproval: tool.requiresApproval,
    retrySafe: !tool.requiresApproval,
    timeoutMs: 30_000,
    validate: (input) => {
      try {
        return validateJsonSchema(tool.inputSchema, input).length === 0 &&
          Buffer.byteLength(JSON.stringify(input), 'utf8') <= 64_000
      } catch {
        return false
      }
    },
    describeAction: (input) => `${server.name} — ${tool.name}:\n${JSON.stringify(input, null, 2)}`,
    execute: async ({ input }) => {
      try {
        return await callTool({
          url: server.url,
          apiKey: server.apiKey,
          headers: server.headers,
          toolName: tool.name,
          input,
        })
      } catch (cause) {
        if (/^MCP tool reported an execution error/i.test(cause.message || '')) throw cause
        throw new Error(`MCP server ${server.name} is offline: ${cause.message || 'the request was rejected'}. Check its status in Connections.`, { cause })
      }
    },
    verifyResult: (result) => Boolean(result && result.isError !== true),
  }
}

function publicServer(server) {
  return {
    id: server.serverId,
    name: server.name,
    url: server.url,
    toolsCount: Array.isArray(server.tools) ? server.tools.length : 0,
    status: server.connectionStatus || 'connected',
    ...(server.lastError ? { lastError: server.lastError } : {}),
    hasApiKey: Boolean(server.apiKey),
    customHeaderNames: Object.keys(server.headers || {}),
    ...(server.lastTestedAt ? { lastTestedAt: server.lastTestedAt } : {}),
  }
}

function mcpToolId(serverId, toolName) {
  const slug = toolName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 52) || 'tool'
  const hash = createHash('sha256').update(toolName).digest('hex').slice(0, 8)
  return `mcp:${serverId}:${slug}:${hash}`
}

function validateName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 100) throw Object.assign(new Error('Server name must be between 1 and 100 characters.'), { status: 400 })
  return name
}

function validateApiKey(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\r\n]/.test(value)) {
    throw Object.assign(new Error('MCP API key must be at most 2000 characters and cannot contain line breaks.'), { status: 400 })
  }
  return value.trim()
}

function validateServerId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) {
    throw Object.assign(new Error('MCP server ID is invalid.'), { status: 400 })
  }
  return value
}
