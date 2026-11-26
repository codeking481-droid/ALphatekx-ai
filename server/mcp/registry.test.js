import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptCredential } from '../integrations/credential-vault.js'
import { getTool, listTools, withScopedTools } from '../tools/registry.js'
import { loadUserMcpTools, setMcpToolEnabled } from './registry.js'

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
      { name: 'hidden_page', description: 'Read a hidden page', inputSchema: { type: 'object', properties: {} }, requiresApproval: false, enabled: false },
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

  test('users can disable MCP tools and down-server errors name their connector', async () => {
    const credentials = {
      serverId,
      name: 'Workspace',
      url: 'https://mcp.example.com/mcp',
      apiKey: '',
      headers: {},
      tools: [{
        name: 'search_pages',
        description: 'Search pages',
        inputSchema: { type: 'object', properties: {} },
        requiresApproval: false,
      }],
    }
    let sealed = encryptCredential(JSON.stringify(credentials))
    const database = {
      async query(sql, values) {
        if (sql.includes('SELECT provider_id, encrypted_credentials')) {
          return { rows: [{
            provider_id: `mcp:${serverId}`,
            encrypted_credentials: sealed.value,
            credential_key_version: sealed.version,
          }] }
        }
        if (sql.includes('SELECT encrypted_credentials')) {
          assert.deepEqual(values, ['user-1', `mcp:${serverId}`])
          return { rows: [{ encrypted_credentials: sealed.value, credential_key_version: sealed.version }] }
        }
        if (sql.includes('UPDATE integration_accounts')) {
          sealed = { value: values[2], version: values[3] }
          return { rowCount: 1, rows: [] }
        }
        throw new Error(`Unexpected query: ${sql}`)
      },
    }
    await setMcpToolEnabled({ userId: 'user-1', serverId, toolName: 'search_pages', enabled: false, database })
    const tools = await loadUserMcpTools({ userId: 'user-1', database })
    assert.equal(tools.length, 0)

    credentials.tools[0].enabled = true
    sealed = encryptCredential(JSON.stringify(credentials))
    const failingTools = await loadUserMcpTools({
      userId: 'user-1',
      database,
      callTool: async () => { throw new Error('ECONNREFUSED') },
    })
    await withScopedTools(failingTools, async () => {
      const tool = listTools().find(({ connector }) => connector === 'mcp')
      await assert.rejects(getTool(tool.id).execute({ input: {} }), /MCP server Workspace is offline: ECONNREFUSED/)
    })
  })

  await withScopedTools(tools, async () => {
    const listed = listTools().filter(({ connector }) => connector === 'mcp')
    assert.equal(listed.length, 2)
    assert.equal(listed.some(({ name }) => name.includes('hidden_page')), false)
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
