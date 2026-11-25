import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { decryptLinkedInToken, encryptLinkedInToken, getLinkedInEncryptionKey } from './crypto.js'

test('LinkedIn credential encryption authenticates ciphertext and rejects invalid keys', () => {
  const key = randomBytes(32).toString('base64')
  const encrypted = encryptLinkedInToken('private access token', key)
  assert.equal(decryptLinkedInToken(encrypted, key), 'private access token')

  const tampered = Buffer.from(encrypted)
  tampered[tampered.length - 1] ^= 1
  assert.throws(() => decryptLinkedInToken(tampered, key))
  assert.throws(() => getLinkedInEncryptionKey('not-a-32-byte-key'))
})
