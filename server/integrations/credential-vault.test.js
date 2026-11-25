import test from 'node:test'
import assert from 'node:assert/strict'

process.env.BETTER_AUTH_SECRET ||= 'test-secret-that-is-never-used-outside-tests'
const { encryptCredential, decryptCredential } = await import('./credential-vault.js')

test('integration credentials encrypt, decrypt, and authenticate ciphertext', () => {
  const encrypted = encryptCredential('provider-token')
  assert.notEqual(encrypted.value.toString('utf8'), 'provider-token')
  assert.equal(decryptCredential(encrypted), 'provider-token')
  const modified = Buffer.from(encrypted.value)
  modified[modified.length - 1] ^= 1
  assert.throws(() => decryptCredential({ ...encrypted, value: modified }))
})
