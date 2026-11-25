import { pool } from '../db/pool.js'
import { decryptCredential, encryptCredential } from './credential-vault.js'

export async function storeIntegrationCredentials({ userId, providerId, credentials, scopes = [], database = pool }) {
  const sealed = encryptCredential(JSON.stringify(credentials))
  await database.query(
    `INSERT INTO integration_accounts (user_id, provider_id, encrypted_credentials, credential_key_version, scopes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, provider_id) DO UPDATE SET encrypted_credentials = EXCLUDED.encrypted_credentials,
       credential_key_version = EXCLUDED.credential_key_version, scopes = EXCLUDED.scopes, updated_at = now()`,
    [userId, providerId, sealed.value, sealed.version, scopes],
  )
}

export async function getIntegrationCredentials({ userId, providerId, database = pool }) {
  const { rows } = await database.query(
    `SELECT encrypted_credentials, credential_key_version FROM integration_accounts
     WHERE user_id = $1 AND provider_id = $2`,
    [userId, providerId],
  )
  if (!rows[0]) return null
  return JSON.parse(decryptCredential({ value: rows[0].encrypted_credentials, version: rows[0].credential_key_version }))
}

export async function revokeIntegration({ userId, providerId, database = pool }) {
  await database.query('DELETE FROM integration_accounts WHERE user_id = $1 AND provider_id = $2', [userId, providerId])
}
