import dns from 'node:dns/promises'
import https from 'node:https'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import net from 'node:net'

const PROTOCOL_VERSION = '2025-03-26'
const MAX_RESPONSE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000

export async function validateMcpUrl(value, { lookup = dns.lookup } = {}) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid MCP server URL.')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a valid MCP server URL.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    !hostname || hostname === 'localhost' || /\.(?:localhost|local|internal|test)$/.test(hostname) ||
    net.isIP(hostname)) {
    throw new Error('MCP servers must use a public HTTPS hostname without embedded credentials, query, or fragment.')
  }
  let addresses
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error('The MCP server hostname could not be resolved.')
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('The MCP server must resolve only to public IP addresses.')
  }
  return { url, addresses }
}

export async function listMcpTools({ url, apiKey = '', headers = {}, requestImpl = requestPinned, lookup = dns.lookup } = {}) {
  const safeHeaders = validateMcpHeaders(headers)
  assertCredentialHeaders(apiKey, safeHeaders)
  const session = await initializeSession({ url, apiKey, headers: safeHeaders, requestImpl, lookup })
  try {
    const response = await sendRpc({
      session,
      method: 'tools/list',
      params: {},
      requestImpl,
      lookup,
    })
    if (!Array.isArray(response.tools)) throw new Error('MCP server returned an invalid tools list.')
    return response.tools.map(normalizeRemoteTool)
  } finally {
    await closeSession(session, requestImpl, lookup)
  }
}

export async function callMcpTool({ url, apiKey = '', headers = {}, toolName, input, requestImpl = requestPinned, lookup = dns.lookup } = {}) {
  if (typeof toolName !== 'string' || !toolName) throw new TypeError('An MCP tool name is required.')
  const safeHeaders = validateMcpHeaders(headers)
  assertCredentialHeaders(apiKey, safeHeaders)
  const session = await initializeSession({ url, apiKey, headers: safeHeaders, requestImpl, lookup })
  try {
    const response = await sendRpc({
      session,
      method: 'tools/call',
      params: { name: toolName, arguments: input },
      requestImpl,
      lookup,
    })
    if (response.isError === true) throw new Error('The MCP tool reported an execution error.')
    return response
  } finally {
    await closeSession(session, requestImpl, lookup)
  }
}

async function initializeSession({ url, apiKey, headers, requestImpl, lookup }) {
  const target = await validateMcpUrl(url, { lookup })
  const response = await requestImpl({
    url: target.url,
    addresses: target.addresses,
    method: 'POST',
    headers: makeHeaders(apiKey, null, headers),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Biz', version: '1.0.0' },
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const initialized = parseRpcResponse(response.body, 1)
  if (!initialized?.protocolVersion || !initialized.capabilities) {
    throw new Error('MCP server returned an invalid initialization response.')
  }
  const session = {
    url: target.url,
    addresses: target.addresses,
    apiKey,
    headers,
    sessionId: response.headers['mcp-session-id'] || response.headers['Mcp-Session-Id'] || null,
    requestImpl,
    lookup,
  }
  await sendNotification(session, 'notifications/initialized')
  return session
}

async function sendRpc({ session, method, params, requestImpl, lookup }) {
  const target = await validateMcpUrl(session.url.toString(), { lookup })
  const response = await requestImpl({
    url: target.url,
    addresses: target.addresses,
    method: 'POST',
    headers: makeHeaders(session.apiKey, session.sessionId, session.headers),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return parseRpcResponse(response.body, 2)
}

async function sendNotification(session, method) {
  const response = await session.requestImpl({
    url: session.url,
    addresses: session.addresses,
    method: 'POST',
    headers: makeHeaders(session.apiKey, session.sessionId, session.headers),
    body: JSON.stringify({ jsonrpc: '2.0', method }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status < 200 || response.status >= 300) throw new Error('MCP server rejected session initialization.')
}

async function closeSession(session, requestImpl, lookup) {
  if (!session.sessionId) return
  try {
    const target = await validateMcpUrl(session.url.toString(), { lookup })
    await requestImpl({
      url: target.url,
      addresses: target.addresses,
      method: 'DELETE',
      headers: makeHeaders(session.apiKey, session.sessionId, session.headers),
      body: '',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    // Session cleanup is best-effort; the server-side session expires independently.
  }
}

export function createPinnedLookup(addresses) {
  const address = addresses?.[0]
  if (!address || typeof address.address !== 'string' || !Number.isInteger(address.family)) {
    throw new Error('The MCP server has no valid public IP address.')
  }
  return (_hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    if (options?.all) callback(null, [address])
    else callback(null, address.address, address.family)
  }
}

function makeHeaders(apiKey, sessionId = null, customHeaders = {}) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  return { ...headers, ...customHeaders }
}

export function validateMcpHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 16) {
    throw new Error('Additional MCP headers must be a JSON object with at most 16 entries.')
  }
  const result = {}
  const names = new Set()
  const blocked = new Set([
    'accept', 'connection', 'content-length', 'content-type', 'cookie', 'host',
    'mcp-protocol-version', 'mcp-session-id', 'proxy-authorization', 'set-cookie',
    'transfer-encoding', 'upgrade',
  ])
  for (const [name, headerValue] of Object.entries(value)) {
    try {
      validateHeaderName(name)
      validateHeaderValue(name, headerValue)
    } catch {
      throw new Error('An additional MCP header name or value is invalid.')
    }
    const lowerName = name.toLowerCase()
    if (blocked.has(lowerName) || names.has(lowerName) || typeof headerValue !== 'string' ||
      ['__proto__', 'constructor', 'prototype'].includes(lowerName) ||
      headerValue.length > 2000 || /[\r\n]/.test(headerValue)) {
      throw new Error('An additional MCP header is blocked or invalid.')
    }
    names.add(lowerName)
    result[name] = headerValue
  }
  return result
}

function assertCredentialHeaders(apiKey, headers) {
  if (apiKey && Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    throw new Error('Use either the API key field or an Authorization header, not both.')
  }
}

function parseRpcResponse(body, id) {
  let data
  try {
    const trimmed = body.trim()
    data = trimmed.startsWith('{')
      ? JSON.parse(trimmed)
      : trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5).trim()))
        .find((event) => event.id === id)
  } catch (cause) {
    throw new Error('MCP server returned invalid JSON.', { cause })
  }
  if (!data || data.id !== id || data.jsonrpc !== '2.0') throw new Error('MCP server returned an invalid protocol response.')
  if (data.error) throw new Error(`MCP request failed: ${String(data.error.message || 'server error').slice(0, 200)}`)
  if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) {
    throw new Error('MCP server returned an invalid protocol result.')
  }
  return data.result
}

function normalizeRemoteTool(tool) {
  if (!tool || typeof tool.name !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(tool.name) ||
    (tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > 2000)) ||
    !isJsonObject(tool.inputSchema) || tool.inputSchema.type !== 'object' ||
    Buffer.byteLength(JSON.stringify(tool.inputSchema), 'utf8') > 32_000) {
    throw new Error('MCP server returned an invalid tool definition.')
  }
  const destructive = /\b(create|write|update|edit|delete|remove|send|post|publish|invite|pay|transfer|execute)\b/i
  const readOnly = /\b(read|list|search|find|get|fetch|query|view)\b/i
  const name = tool.name.toLowerCase().replace(/[_.:-]+/g, ' ')
  const description = (tool.description || '').toLowerCase().replace(/[_.:-]+/g, ' ')
  return {
    name: tool.name,
    description: tool.description || `MCP tool ${tool.name}`,
    inputSchema: tool.inputSchema,
    requiresApproval: destructive.test(`${name} ${description}`) || !readOnly.test(`${name} ${description}`),
  }
}

async function requestPinned({ url, addresses, method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      headers,
      signal,
      lookup: createPinnedLookup(addresses),
    }, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('MCP response exceeded the size limit.'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`MCP server returned HTTP ${response.statusCode}.`))
          return
        }
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.on('error', reject)
    })
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('MCP server request timed out.')))
    request.on('error', reject)
    request.end(body)
  })
}

function isPublicAddress(value) {
  const family = net.isIP(value)
  if (family === 4) {
    const [a, b, c] = value.split('.').map(Number)
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 && c <= 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (family !== 6) return false
  const address = value.toLowerCase()
  const firstWord = Number.parseInt(address.split(':')[0] || '0', 16)
  const secondWord = Number.parseInt(address.split(':')[1] || '0', 16)
  return firstWord >= 0x2000 && firstWord <= 0x3fff &&
    !(firstWord === 0x2001 && [0, 2, 0x10, 0x20, 0xdb8].includes(secondWord)) &&
    firstWord !== 0x2002 && firstWord !== 0x3fff
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
