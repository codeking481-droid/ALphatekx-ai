import test from 'node:test'
import assert from 'node:assert/strict'
import { listUserApiKeys, saveUserApiKey, withUserProviderRegistry } from './byok.js'

test('BYOK credentials are encrypted and only the last four characters are returned', async () => {
  let stored
  const database = {
    async query(sql, params) {
      if (sql.includes('INSERT INTO integration_accounts')) {
        stored = {
          provider_id: params[1],
          encrypted_credentials: params[2],
          credential_key_version: params[3],
        }
        return { rowCount: 1 }
      }
      assert.match(sql, /provider_id LIKE 'byok:%'/)
      return { rows: stored ? [stored] : [] }
    },
  }

  const saved = await saveUserApiKey({
    userId: 'user-1',
    providerId: 'openai',
    apiKey: 'sk-test-secret-1234',
    database,
  })
  const listed = await listUserApiKeys({ userId: 'user-1', database })

  assert.equal(saved.keySuffix, '1234')
  assert.deepEqual(listed, {
    keys: [{ provider: 'openai', configured: true, keySuffix: '1234' }],
    hasOwnKey: true,
  })
  assert.ok(Buffer.isBuffer(stored.encrypted_credentials))
  assert.doesNotMatch(stored.encrypted_credentials.toString('utf8'), /sk-test-secret-1234/)
})

test('a saved user provider overrides its default and preserves other providers without exposing keys', async () => {
  const { encryptCredential } = await import('../integrations/credential-vault.js')
  const sealed = encryptCredential(JSON.stringify({ apiKey: 'sk-user-owned-9876' }))
  const database = {
    async query() {
      return {
        rows: [{
          provider_id: 'byok:groq',
          encrypted_credentials: sealed.value,
          credential_key_version: sealed.version,
        }],
      }
    },
  }
  const fallback = { id: 'workers_ai', name: 'Workers AI', available: true }
  const baseRegistry = { list: () => [fallback], get: (id) => id === 'workers_ai' ? fallback : null }
  let selected
  await withUserProviderRegistry({
    userId: 'user-1',
    database,
    registry: baseRegistry,
    env: { AI_MODEL_OPENAI: 'test-model', AI_MODEL_GROQ: 'paid-groq-model' },
  }, async (registry) => {
    selected = registry.list()
    assert.equal(registry.get('groq').model, 'llama-3.3-70b-versatile')
    assert.equal(registry.get('workers_ai'), fallback)
  })

  assert.deepEqual(selected.map(({ id }) => id), ['workers_ai', 'groq'])
  assert.doesNotMatch(JSON.stringify(selected), /sk-user-owned-9876/)
})

test('a saved Gemini key is restricted to the configured free-tier model', async () => {
  const { encryptCredential } = await import('../integrations/credential-vault.js')
  const sealed = encryptCredential(JSON.stringify({ apiKey: 'AIzaSy-user-owned-9876' }))
  const database = {
    async query() {
      return {
        rows: [{
          provider_id: 'byok:gemini',
          encrypted_credentials: sealed.value,
          credential_key_version: sealed.version,
        }],
      }
    },
  }
  const registry = {
    list: () => [],
    get: () => null,
  }
  await withUserProviderRegistry({
    userId: 'user-1',
    database,
    registry,
    env: { AI_MODEL_GEMINI: 'gemini-pro' },
  }, async (userRegistry) => {
    assert.equal(userRegistry.get('gemini').model, 'gemini-2.5-flash')
  })
})
