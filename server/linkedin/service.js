import { createHash, randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { pool } from '../db/pool.js'
import { decryptLinkedInToken, encryptLinkedInToken, getLinkedInEncryptionKey } from './crypto.js'

const LINKEDIN_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization'
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken'
const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo'
const LINKEDIN_API_ORIGIN = 'https://api.linkedin.com'
const LINKEDIN_SCOPES = ['openid', 'profile', 'email', 'w_member_social']

export function getLinkedInConfig(env = process.env) {
  return {
    clientId: env.LINKEDIN_CLIENT_ID?.trim(),
    clientSecret: env.LINKEDIN_CLIENT_SECRET?.trim(),
    redirectUri: env.LINKEDIN_REDIRECT_URI?.trim() || `${config.webOrigin}/api/linkedin/callback`,
    apiVersion: env.LINKEDIN_API_VERSION?.trim() || '202611',
    encryptionKey: env.LINKEDIN_TOKEN_ENCRYPTION_KEY,
  }
}

export function isLinkedInConfigured(env = process.env) {
  const settings = getLinkedInConfig(env)
  try {
    getLinkedInEncryptionKey(settings.encryptionKey)
    return Boolean(
      settings.clientId &&
      settings.clientSecret &&
      /^https:\/\/.+/.test(settings.redirectUri) &&
      /^\d{6}$/.test(settings.apiVersion),
    )
  } catch {
    return false
  }
}

export async function getLinkedInStatus({ userId, database = pool, env = process.env }) {
  const { rows } = await database.query(
    'SELECT name, expires_at FROM linkedin_connections WHERE user_id = $1',
    [userId],
  )
  return {
    configured: isLinkedInConfigured(env),
    connected: Boolean(rows[0]),
    name: rows[0]?.name || null,
    expiresAt: rows[0]?.expires_at || null,
  }
}

export async function beginLinkedInConnect({ userId, database = pool, env = process.env }) {
  const settings = requireLinkedInConfig(env)
  await database.query('DELETE FROM linkedin_oauth_states WHERE expires_at <= now()')
  const state = randomBytes(32).toString('base64url')
  const stateHash = createHash('sha256').update(state).digest('hex')
  await database.query(
    `INSERT INTO linkedin_oauth_states (state_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '10 minutes')`,
    [stateHash, userId],
  )
  const authorization = new URL(LINKEDIN_AUTH_URL)
  authorization.search = new URLSearchParams({
    response_type: 'code',
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    state,
    scope: LINKEDIN_SCOPES.join(' '),
  }).toString()
  return authorization.toString()
}

export async function completeLinkedInConnect({
  userId,
  state,
  code,
  providerError,
  database = pool,
  env = process.env,
  fetchImpl = fetch,
}) {
  const settings = requireLinkedInConfig(env)
  if (!state || typeof state !== 'string' || state.length > 200) {
    throw httpError('LinkedIn authorization state is missing or invalid.', 401)
  }
  const stateHash = createHash('sha256').update(state).digest('hex')
  const consumed = await database.query(
    `DELETE FROM linkedin_oauth_states
     WHERE state_hash = $1 AND user_id = $2 AND expires_at > now()
     RETURNING user_id`,
    [stateHash, userId],
  )
  if (!consumed.rowCount) throw httpError('LinkedIn authorization state expired or did not match this account.', 401)
  if (providerError) return { denied: true }
  if (!code || typeof code !== 'string' || code.length > 4096) {
    throw httpError('LinkedIn did not return an authorization code.', 400)
  }

  const tokenResponse = await fetchImpl(LINKEDIN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: settings.redirectUri,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const token = await readLinkedInJson(tokenResponse, 'token exchange')
  if (typeof token.access_token !== 'string' || !token.access_token ||
    !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw httpError('LinkedIn returned an invalid access token response.', 502)
  }

  const profileResponse = await fetchImpl(LINKEDIN_USERINFO_URL, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(20_000),
  })
  const profile = await readLinkedInJson(profileResponse, 'profile lookup')
  if (typeof profile.sub !== 'string' || !profile.sub || typeof profile.name !== 'string' || !profile.name.trim()) {
    throw httpError('LinkedIn returned an invalid profile response.', 502)
  }

  const encryptedToken = encryptLinkedInToken(JSON.stringify({
    accessToken: token.access_token,
    refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : null,
    scope: typeof token.scope === 'string' ? token.scope : LINKEDIN_SCOPES.join(' '),
  }), settings.encryptionKey)
  const expiresAt = new Date(Date.now() + token.expires_in * 1000)
  await database.query(
    `INSERT INTO linkedin_connections (user_id, linkedin_id, name, token_encrypted, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET linkedin_id = EXCLUDED.linkedin_id, name = EXCLUDED.name,
       token_encrypted = EXCLUDED.token_encrypted, expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [userId, profile.sub, profile.name.trim().slice(0, 200), encryptedToken, expiresAt],
  )
  return { denied: false }
}

export async function disconnectLinkedIn({ userId, database = pool }) {
  await database.query('DELETE FROM linkedin_connections WHERE user_id = $1', [userId])
}

export async function createLinkedInPost({
  userId,
  text,
  approved,
  approvalId,
  database = pool,
  env = process.env,
  fetchImpl = fetch,
}) {
  const postText = validateText(text, 'Post text', 3000)
  if (approved !== true) {
    return {
      preview: true,
      text: postText,
      approvalId: await createLinkedInApproval({
        userId,
        action: 'post',
        payload: { text: postText },
        database,
      }),
    }
  }
  await consumeLinkedInApproval({
    userId,
    action: 'post',
    payload: { text: postText },
    approvalId,
    database,
  })
  return publishLinkedInPost({ userId, text: postText, database, env, fetchImpl })
}

export async function publishLinkedInPost({ userId, text, database = pool, env = process.env, fetchImpl = fetch }) {
  const postText = validateText(text, 'Post text', 3000)
  const { connection, token } = await getConnection({ userId, database, env })
  const response = await linkedinRequest({
    url: `${LINKEDIN_API_ORIGIN}/rest/posts`,
    method: 'POST',
    token: token.accessToken,
    apiVersion: getLinkedInConfig(env).apiVersion,
    body: {
      author: `urn:li:person:${connection.linkedin_id}`,
      commentary: postText,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    },
    fetchImpl,
  })
  return { preview: false, posted: true, postId: response.headers.get('x-restli-id') }
}

export async function getLinkedInComments({
  userId,
  postId,
  database = pool,
  env = process.env,
  fetchImpl = fetch,
}) {
  const postUrn = validateUrn(postId, /^(?:urn:li:(?:activity|share|ugcPost):)[A-Za-z0-9._:-]+$/, 'Post ID')
  const { token } = await getConnection({ userId, database, env })
  const response = await linkedinRequest({
    url: `${LINKEDIN_API_ORIGIN}/rest/socialActions/${encodeURIComponent(postUrn)}/comments`,
    token: token.accessToken,
    apiVersion: getLinkedInConfig(env).apiVersion,
    fetchImpl,
  })
  let data
  try {
    data = await response.json()
  } catch {
    throw httpError('LinkedIn returned an invalid comments response.', 502)
  }
  if (!Array.isArray(data.elements)) throw httpError('LinkedIn returned an invalid comments response.', 502)
  return {
    items: data.elements.slice(0, 100).map((comment) => ({
      id: comment.commentUrn || comment.id || null,
      author: comment.actor || null,
      text: typeof comment.message?.text === 'string' ? comment.message.text : '',
      createdAt: comment.created?.time || null,
    })),
  }
}

export async function replyToLinkedInComment({
  userId,
  commentId,
  text,
  approved,
  approvalId,
  database = pool,
  env = process.env,
  fetchImpl = fetch,
}) {
  const commentUrn = validateUrn(
    commentId,
    /^urn:li:comment:\((urn:li:(?:activity|share|ugcPost):[A-Za-z0-9._:-]+),[A-Za-z0-9._:-]+\)$/,
    'Comment ID',
  )
  const replyText = validateText(text, 'Reply text', 3000)
  if (approved !== true) {
    return {
      preview: true,
      commentId: commentUrn,
      text: replyText,
      approvalId: await createLinkedInApproval({
        userId,
        action: 'reply',
        payload: { commentId: commentUrn, text: replyText },
        database,
      }),
    }
  }
  await consumeLinkedInApproval({
    userId,
    action: 'reply',
    payload: { commentId: commentUrn, text: replyText },
    approvalId,
    database,
  })
  return publishLinkedInReply({ userId, commentId: commentUrn, text: replyText, database, env, fetchImpl })
}

export async function publishLinkedInReply({
  userId,
  commentId,
  text,
  database = pool,
  env = process.env,
  fetchImpl = fetch,
}) {
  const commentUrn = validateUrn(
    commentId,
    /^urn:li:comment:\((urn:li:(?:activity|share|ugcPost):[A-Za-z0-9._:-]+),[A-Za-z0-9._:-]+\)$/,
    'Comment ID',
  )
  const replyText = validateText(text, 'Reply text', 3000)
  const { connection, token } = await getConnection({ userId, database, env })
  const objectUrn = commentUrn.match(/^urn:li:comment:\((urn:li:(?:activity|share|ugcPost):[A-Za-z0-9._:-]+),/)[1]
  const response = await linkedinRequest({
    url: `${LINKEDIN_API_ORIGIN}/rest/socialActions/${encodeURIComponent(commentUrn)}/comments`,
    method: 'POST',
    token: token.accessToken,
    apiVersion: getLinkedInConfig(env).apiVersion,
    body: {
      actor: `urn:li:person:${connection.linkedin_id}`,
      object: objectUrn,
      parentComment: commentUrn,
      message: { text: replyText },
    },
    fetchImpl,
  })
  return { preview: false, posted: true, commentId: response.headers.get('x-restli-id') }
}

export async function searchLinkedInPeople({
  userId,
  query,
  database = pool,
  env = process.env,
  fetchImpl = fetch,
}) {
  const search = validateText(query, 'Search query', 200)
  const { token } = await getConnection({ userId, database, env })
  const url = new URL(`${LINKEDIN_API_ORIGIN}/v2/people`)
  url.searchParams.set('keywords', search)
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    signal: AbortSignal.timeout(20_000),
  })
  const data = await readLinkedInJson(response, 'people search')
  if (!Array.isArray(data.elements)) throw httpError('LinkedIn returned an invalid people search response.', 502)
  return {
    items: data.elements.slice(0, 10).map((person) => ({
      id: typeof person.id === 'string' ? person.id : null,
      firstName: localizedName(person.firstName),
      lastName: localizedName(person.lastName),
      headline: typeof person.headline === 'string' ? person.headline : null,
    })),
  }
}

async function getConnection({ userId, database, env }) {
  const settings = requireLinkedInConfig(env)
  const { rows } = await database.query(
    `SELECT linkedin_id, token_encrypted, expires_at
     FROM linkedin_connections WHERE user_id = $1`,
    [userId],
  )
  const connection = rows[0]
  if (!connection) throw httpError('Connect a LinkedIn account before using this feature.', 409)
  if (new Date(connection.expires_at).getTime() <= Date.now()) {
    throw httpError('The LinkedIn access token expired. Disconnect and reconnect your account.', 401)
  }
  let token
  try {
    token = JSON.parse(decryptLinkedInToken(connection.token_encrypted, settings.encryptionKey))
  } catch {
    throw httpError('The LinkedIn credential cannot be decrypted. Check LINKEDIN_TOKEN_ENCRYPTION_KEY.', 503)
  }
  if (typeof token.accessToken !== 'string' || !token.accessToken) {
    throw httpError('The stored LinkedIn credential is invalid. Reconnect your account.', 503)
  }
  return { connection, token, settings }
}

async function createLinkedInApproval({ userId, action, payload, database }) {
  const approvalId = randomBytes(32).toString('base64url')
  const approvalHash = createHash('sha256').update(approvalId).digest('hex')
  const payloadHash = createHash('sha256').update(JSON.stringify([action, payload])).digest('hex')
  await database.query('DELETE FROM linkedin_action_approvals WHERE expires_at <= now()')
  await database.query(
    `INSERT INTO linkedin_action_approvals (approval_hash, user_id, action, payload_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
    [approvalHash, userId, action, payloadHash],
  )
  return approvalId
}

async function consumeLinkedInApproval({ userId, action, payload, approvalId, database }) {
  if (typeof approvalId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(approvalId)) {
    throw httpError('A valid preview approval is required before publishing.', 403)
  }
  const approvalHash = createHash('sha256').update(approvalId).digest('hex')
  const payloadHash = createHash('sha256').update(JSON.stringify([action, payload])).digest('hex')
  const consumed = await database.query(
    `DELETE FROM linkedin_action_approvals
     WHERE approval_hash = $1 AND user_id = $2 AND action = $3
       AND payload_hash = $4 AND expires_at > now()
     RETURNING user_id`,
    [approvalHash, userId, action, payloadHash],
  )
  if (!consumed.rowCount) throw httpError('The preview approval is missing, expired, already used, or no longer matches this action.', 409)
}

async function linkedinRequest({ url, method = 'GET', token, apiVersion, body, fetchImpl }) {
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'LinkedIn-Version': apiVersion,
      'X-Restli-Protocol-Version': '2.0.0',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? response.status : 502
    throw httpError(
      status === 403
        ? 'LinkedIn denied this request. Confirm the app has the required product access and permissions.'
        : status === 401
          ? 'LinkedIn rejected the access token. Reconnect your account.'
          : `LinkedIn request failed (HTTP ${response.status}).`,
      status,
    )
  }
  return response
}

async function readLinkedInJson(response, action) {
  let data
  try {
    data = await response.json()
  } catch {
    throw httpError(`LinkedIn returned an invalid response during ${action}.`, 502)
  }
  if (!response.ok) {
    throw httpError(`LinkedIn ${action} failed (HTTP ${response.status}).`, response.status === 400 ? 400 : 502)
  }
  return data
}

function requireLinkedInConfig(env) {
  const settings = getLinkedInConfig(env)
  if (!settings.clientId || !settings.clientSecret) {
    throw httpError('LinkedIn is not configured on the server.', 503)
  }
  if (!/^https:\/\/.+/.test(settings.redirectUri)) {
    throw httpError('LINKEDIN_REDIRECT_URI must be an HTTPS URL.', 503)
  }
  if (!/^\d{6}$/.test(settings.apiVersion)) {
    throw httpError('LINKEDIN_API_VERSION must use YYYYMM format.', 503)
  }
  getLinkedInEncryptionKey(settings.encryptionKey)
  return settings
}

function validateText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw httpError(`${label} must contain 1 to ${maxLength} characters.`, 400)
  }
  return value.trim()
}

function validateUrn(value, pattern, label) {
  if (typeof value !== 'string' || value.length > 500 || !pattern.test(value)) {
    throw httpError(`${label} is invalid.`, 400)
  }
  return value
}

function localizedName(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null
  const preferred = value.preferredLocale
  if (preferred && typeof value.localized?.[`${preferred.language}_${preferred.country}`] === 'string') {
    return value.localized[`${preferred.language}_${preferred.country}`]
  }
  return Object.values(value.localized || {}).find((name) => typeof name === 'string') || null
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status })
}
