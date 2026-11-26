import test from 'node:test'
import assert from 'node:assert/strict'
import { listMcpTools, validateMcpHeaders, validateMcpUrl } from './client.js'

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

test('MCP URL validation rejects non-HTTPS and private DNS destinations', async () => {
  await assert.rejects(validateMcpUrl('http://example.com/mcp', { lookup: publicLookup }), /public HTTPS/)
  await assert.rejects(validateMcpUrl('https://example.com/mcp', {
    lookup: async () => [{ address: '10.1.2.3', family: 4 }],
  }), /only to public/)
  await assert.rejects(validateMcpUrl('https://localhost/mcp', { lookup: publicLookup }), /public HTTPS/)
  await assert.rejects(validateMcpUrl('https://example.com/mcp?token=secret', { lookup: publicLookup }), /query, or fragment/)
})

test('MCP custom headers accept encrypted credential values but reject unsafe transport headers', () => {
  assert.deepEqual(validateMcpHeaders({ 'X-API-Key': 'private-value' }), { 'X-API-Key': 'private-value' })
  assert.throws(() => validateMcpHeaders({ Host: '127.0.0.1' }), /blocked or invalid/)
  assert.throws(() => validateMcpHeaders({ 'X-API-Key': 'one', 'x-api-key': 'two' }), /blocked or invalid/)
})

test('Streamable HTTP client initializes a session and classifies MCP tools generically', async () => {
  const calls = []
  const requestImpl = async ({ body, method }) => {
    calls.push({ method, request: body ? JSON.parse(body) : null })
    if (method === 'DELETE') return { status: 200, headers: {}, body: '' }
    if (!body) return { status: 202, headers: {}, body: '' }
    const request = JSON.parse(body)
    if (request.method === 'initialize') {
      return {
        status: 200,
        headers: { 'mcp-session-id': 'session-1' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } },
        }),
      }
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            { name: 'search_pages', inputSchema: { type: 'object', properties: {} } },
            { name: 'create_page', description: 'Create a page', inputSchema: { type: 'object', properties: {} } },
          ],
        },
      }),
    }
  }

  const tools = await listMcpTools({
    url: 'https://mcp.example.com/mcp',
    requestImpl,
    lookup: publicLookup,
  })

  assert.deepEqual(tools.map(({ name, requiresApproval }) => ({ name, requiresApproval })), [
    { name: 'search_pages', requiresApproval: false },
    { name: 'create_page', requiresApproval: true },
  ])
  assert.equal(calls[0].request.method, 'initialize')
  assert.equal(calls[1].request.method, 'notifications/initialized')
  assert.equal(calls[2].request.method, 'tools/list')
  assert.equal(calls[2].method, 'POST')
  assert.equal(calls[3].method, 'DELETE')
})
