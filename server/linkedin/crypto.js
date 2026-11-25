import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const algorithm = 'aes-256-gcm'

export function getLinkedInEncryptionKey(value = process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY) {
  if (!value) {
    throw new Error('LINKEDIN_TOKEN_ENCRYPTION_KEY is not configured.')
  }
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('LINKEDIN_TOKEN_ENCRYPTION_KEY must be base64-encoded 32-byte key material.')
  }
  return key
}

export function encryptLinkedInToken(plaintext, value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(algorithm, getLinkedInEncryptionKey(value), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

export function decryptLinkedInToken(encrypted, value) {
  if (!Buffer.isBuffer(encrypted) || encrypted.length < 29) {
    throw new Error('The stored LinkedIn credential is invalid.')
  }
  const iv = encrypted.subarray(0, 12)
  const tag = encrypted.subarray(12, 28)
  const ciphertext = encrypted.subarray(28)
  const decipher = createDecipheriv(algorithm, getLinkedInEncryptionKey(value), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
