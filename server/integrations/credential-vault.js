import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from '../config.js'

const algorithm = 'aes-256-gcm'
const key = () => createHash('sha256').update(config.authSecret).digest()

export function encryptCredential(plaintext) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(algorithm, key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    version: 'v1',
    value: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
  }
}

export function decryptCredential(encrypted) {
  if (encrypted.version !== 'v1' || encrypted.value.length < 29) throw new Error('Unsupported encrypted credential format.')
  const iv = encrypted.value.subarray(0, 12)
  const tag = encrypted.value.subarray(12, 28)
  const ciphertext = encrypted.value.subarray(28)
  const decipher = createDecipheriv(algorithm, key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
