import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptCredential } from '../integrations/credential-vault.js'
import { getTool, listTools, withScopedTools } from '../tools/registry.js'
import { loadUserMcpTools } from './registry.js'

const serverId = 'c65d4ec2-bde4-4d4c-88b6-0d2f55b6022e'

test('per-user MCP tools share the registry and retain generic approval policy', async () => {
  const sealed = encryptCredential(JSON.stringify({
    serverId,
    name: 'Workspace',
    url: 'https://mcp.example.com/mcp',
    apiKey: 'secret-key',
    tools: [
      { name: 'search_pages', description: 'Search pages', inputSchema: { type: 'object', properties: {} }, requiresApproval: false },
      { name: 'create_page', description: 'Create a page', inputSchema: { type: 'object', properties: {} }, requiresApproval: true },
    ],
  }))
  const database = {
    async query(_sql, params) {
      assert.deepEqual(params, ['user-1'])
      return {
        rows: [{
          provider_id: `mcp:${serverId}`,
          encrypted_credentials: sealed.value,
          credential_key_version: sealed.version,
        }],
      }
    },
  }
  const calls = []
  const tools = await loadUserMcpTools({
    userId: 'user-1',
    database,
    callTool: async (request) => {
      calls.push(request)
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  })

  await withScopedTools(tools, async () => {
    const listed = listTools().filter(({ connector }) => connector === 'mcp')
    assert.equal(listed.length, 2)
    assert.equal(listed.find(({ id }) => id.includes('search_pages')).requiresApproval, false)
    assert.equal(listed.find(({ id }) => id.includes('create_page')).requiresApproval, true)
    assert.ok(listed.every((tool) => !JSON.stringify(tool).includes('secret-key')))

    const createTool = listed.find(({ id }) => id.includes('create_page'))
    assert.deepEqual(await getTool(createTool.id).execute({ input: { title: 'Launch' } }), {
      content: [{ type: 'text', text: 'ok' }],
    })
  })
  assert.equal(calls[0].toolName, 'create_page')
  assert.equal(calls[0].apiKey, 'secret-key')
})
