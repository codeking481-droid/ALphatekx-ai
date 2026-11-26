import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getTool,
  listTools,
  parseApprovalDescription,
  registerTool,
  serializeApprovalDescription,
} from './registry.js'

test('tool registry exposes connector metadata and generic redacted approval previews', () => {
  const unregister = registerTool({
    id: 'gmail_send',
    name: 'Send Gmail Message',
    connector: 'gmail',
    description: 'Send an email.',
    inputSchema: { type: 'object' },
    permissions: ['tool:approved'],
    validate: () => true,
    execute: async () => ({ sent: true }),
  })
  try {
    const listed = listTools().find(({ id }) => id === 'gmail_send')
    assert.equal(listed.name, 'Send Gmail Message')
    assert.equal(listed.connector, 'gmail')
    assert.equal(getTool('gmail_send').name, 'Send Gmail Message')

    const approval = parseApprovalDescription(serializeApprovalDescription(getTool('gmail_send'), {
      to: 'daniel@example.com',
      body: 'Biz is launching.',
      access_token: 'do-not-display',
    }))
    assert.match(approval.description, /Send Gmail Message/)
    assert.match(approval.description, /Biz is launching/)
    assert.match(approval.description, /\[redacted\]/)
    assert.doesNotMatch(approval.description, /do-not-display/)
  } finally {
    unregister()
  }
})

test('tool registry supplies generic display metadata when optional labels are omitted', () => {
  const unregister = registerTool({
    id: 'sample_connector_action',
    description: 'A sample action.',
    inputSchema: { type: 'object' },
    permissions: ['tool:read'],
    validate: () => true,
    execute: async () => ({ ok: true }),
  })
  try {
    const [tool] = listTools().filter(({ id }) => id === 'sample_connector_action')
    assert.equal(tool.name, 'Sample Connector Action')
    assert.equal(tool.connector, 'builtin')
  } finally {
    unregister()
  }
})
