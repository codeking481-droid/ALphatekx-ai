import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pool } from '../db/pool.js'
import { audit } from '../observability/audit.js'
import { config } from '../config.js'
import {
  getAvailableSkills,
  existingSafeDirectory,
  getUserSkillsDirectory,
  parseSkillMarkdown,
} from './loader.js'

export async function listSkills({ userId, database = pool, skillsDir = config.skillsDir }) {
  const skills = await getAvailableSkills({ userId, database, skillsDir })
  return skills.map(({ markdown, body, sourcePath, ...skill }) => skill)
}

export async function installSkill({
  userId,
  markdown,
  database = pool,
  skillsDir = config.skillsDir,
  approvedDangerous = false,
  source = 'upload',
  supportingFiles = [],
}) {
  const skill = parseSkillMarkdown(markdown)
  const safeSupportingFiles = normalizeSupportingFiles(supportingFiles)
  if (skill.name === 'create-skill') throw httpError(409, 'The built-in create-skill skill cannot be replaced.')
  const available = await getAvailableSkills({ userId, database, skillsDir })
  const existing = available.find((item) => item.name === skill.name)

  if (existing?.bundled) {
    if (contentHash(existing.markdown) !== contentHash(markdown)) {
      throw httpError(409, 'A bundled skill already uses this name; it cannot be overwritten.')
    }
    return setSkillEnabled({
      userId,
      name: skill.name,
      enabled: true,
      database,
      skillsDir,
      approvedDangerous,
      markdown,
      source,
    })
  }
  if (existing) throw httpError(409, `Skill "${skill.name}" is already installed.`)
  if (skill.dangerous && !approvedDangerous) {
    const approval = await createSkillApproval({ userId, skill, action: 'install', database, source, supportingFiles: safeSupportingFiles })
    return { status: 'pending_approval', approval }
  }

  const target = await writePersonalSkill({ userId, name: skill.name, markdown, supportingFiles: safeSupportingFiles, skillsDir })
  try {
    await database.query(
      `INSERT INTO user_skills (user_id, name, enabled, source)
       VALUES ($1, $2, TRUE, $3)
       ON CONFLICT (user_id, name) DO UPDATE SET enabled = TRUE, source = EXCLUDED.source, updated_at = now()`,
      [userId, skill.name, persistedSource(source)],
    )
    await audit({
      userId,
      event: 'skill.installed',
      resourceType: 'skill',
      resourceId: skill.name,
      details: { name: skill.name, version: skill.version, source, tools: skill.tools },
    }, database)
  } catch (error) {
    await rm(path.dirname(target), { recursive: true, force: true })
    throw error
  }
  return { status: 'installed', skill: publicSkill(skill, { enabled: true, source: displaySource(source) }) }
}

export async function setSkillEnabled({
  userId,
  name,
  enabled,
  database = pool,
  skillsDir = config.skillsDir,
  approvedDangerous = false,
  markdown = null,
  source = 'settings',
}) {
  if (typeof enabled !== 'boolean') throw httpError(400, 'enabled must be a boolean.')
  const skills = await getAvailableSkills({ userId, database, skillsDir })
  const skill = skills.find((item) => item.name === name)
  if (!skill) throw httpError(404, 'Skill not found.')
  if (skill.builtin) throw httpError(403, 'The built-in create-skill skill cannot be disabled.')

  if (enabled && skill.dangerous && !approvedDangerous) {
    const approval = await createSkillApproval({
      userId,
      skill: { ...skill, markdown: markdown || skill.markdown },
      action: 'enable',
      database,
      source,
    })
    return { status: 'pending_approval', approval }
  }
  await database.query(
    `INSERT INTO user_skills (user_id, name, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [userId, name, enabled],
  )
  await audit({
    userId,
    event: enabled ? 'skill.enabled' : 'skill.disabled',
    resourceType: 'skill',
    resourceId: name,
    details: { name, version: skill.version, source },
  }, database)
  return { status: enabled ? 'enabled' : 'disabled', skill: publicSkill(skill, { enabled }) }
}

export async function removeSkill({ userId, name, database = pool, skillsDir = config.skillsDir }) {
  if (!isSkillName(name) || name === 'create-skill') throw httpError(400, 'Skill name is invalid.')
  const userDirectory = getUserSkillsDirectory(userId, skillsDir)
  if (!await existingSafeDirectory(skillsDir)) throw httpError(404, 'Skills folder not found.')
  const usersDirectory = path.join(skillsDir, 'users')
  if (!await existingSafeDirectory(usersDirectory) || !await existingSafeDirectory(userDirectory)) {
    throw httpError(404, 'Personal skill not found. Bundled skills can be disabled but not deleted.')
  }
  const skillDirectory = path.join(userDirectory, name)
  const directoryStat = await lstat(skillDirectory).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw httpError(404, 'Personal skill not found. Bundled skills can be disabled but not deleted.')
  }
  const skillFile = path.join(skillDirectory, 'SKILL.md')
  const fileStat = await lstat(skillFile).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) throw httpError(404, 'Personal skill file not found.')
  const skill = parseSkillMarkdown(await readFile(skillFile, 'utf8'))
  if (skill.name !== name) throw httpError(409, 'Skill folder and frontmatter names do not match.')

  await rm(skillDirectory, { recursive: true })
  await database.query('DELETE FROM user_skills WHERE user_id = $1 AND name = $2', [userId, name])
  await audit({
    userId,
    event: 'skill.removed',
    resourceType: 'skill',
    resourceId: name,
    details: { name, version: skill.version },
  }, database)
  return true
}

export async function listSkillApprovals({ userId, database = pool }) {
  const { rows } = await database.query(
    `SELECT id, name, action, markdown, source, expires_at, created_at
     FROM skill_install_requests
     WHERE user_id = $1 AND status = 'pending' AND expires_at > now()
     ORDER BY created_at`,
    [userId],
  )
  return rows.map((row) => ({
    ...row,
    tools: parseSkillMarkdown(row.markdown).tools,
  }))
}

export async function decideSkillApproval({ userId, approvalId, decision, database = pool, skillsDir = config.skillsDir }) {
  if (!['approved', 'denied'].includes(decision)) throw httpError(400, 'Decision must be approved or denied.')
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, name, action, markdown, source, status, supporting_files
       FROM skill_install_requests
       WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > now()
       FOR UPDATE`,
      [approvalId, userId],
    )
    const request = rows[0]
    if (!request) throw httpError(404, 'Pending skill approval not found or expired.')
    let skill = null
    if (decision === 'approved') {
      if (request.action === 'install') {
        const installed = await installSkill({
          userId,
          markdown: request.markdown,
          database: client,
          skillsDir,
          approvedDangerous: true,
          source: request.source,
          supportingFiles: decodeSupportingFiles(request.supporting_files),
        })
        if (installed.status !== 'installed' && installed.status !== 'enabled') {
          throw new Error('Approved skill could not be installed.')
        }
        skill = installed.skill
      } else {
        const skills = await getAvailableSkills({ userId, database: client, skillsDir })
        const requestedSkill = skills.find((item) => item.name === request.name)
        if (!requestedSkill) throw httpError(404, 'Skill no longer exists.')
        await client.query(
          `INSERT INTO user_skills (user_id, name, enabled) VALUES ($1, $2, TRUE)
           ON CONFLICT (user_id, name) DO UPDATE SET enabled = TRUE, updated_at = now()`,
          [userId, request.name],
        )
        skill = publicSkill(requestedSkill, { enabled: true })
      }
    }
    await client.query(
      `UPDATE skill_install_requests SET status = $3, decided_at = now()
       WHERE id = $1 AND user_id = $2`,
      [approvalId, userId, decision],
    )
    await audit({
      userId,
      event: `skill.approval.${decision}`,
      resourceType: 'skill_approval',
      resourceId: approvalId,
      details: { name: request.name, action: request.action },
    }, client)
    await client.query('COMMIT')
    return { status: decision, skill }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function writeSkillFromAgent({ userId, markdown, database = pool, skillsDir = config.skillsDir }) {
  const result = await installSkill({
    userId,
    markdown,
    database,
    skillsDir,
    source: 'create-skill',
  })
  if (result.status === 'pending_approval') {
    return {
      name: result.approval.name,
      status: 'pending_approval',
      approval: result.approval,
    }
  }
  if (result.status !== 'installed') throw new Error('The skill could not be installed after approval.')
  const skills = await getAvailableSkills({ userId, database, skillsDir })
  const loaded = skills.find((item) => item.name === result.skill.name)
  if (!loaded || !loaded.enabled) throw new Error('The installed skill did not pass the runtime loader check.')
  return { name: loaded.name, version: loaded.version, status: 'installed', tools: loaded.tools }
}

export async function initializeSkills(options = {}) {
  const { initializeSkillLoader } = await import('./loader.js')
  return initializeSkillLoader(options)
}

async function createSkillApproval({ userId, skill, action, database, source, supportingFiles = [] }) {
  const { rows } = await database.query(
    `INSERT INTO skill_install_requests (user_id, name, action, markdown, source, supporting_files, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', now() + interval '30 minutes')
     RETURNING id, name, action, expires_at, created_at`,
    [userId, skill.name, action, skill.markdown, persistedSource(source), JSON.stringify(encodeSupportingFiles(supportingFiles))],
  )
  const approval = rows[0]
  await audit({
    userId,
    event: 'skill.approval.requested',
    resourceType: 'skill_approval',
    resourceId: approval.id,
    details: { name: skill.name, version: skill.version, action, tools: skill.tools, source },
  }, database)
  return approval
}

async function writePersonalSkill({ userId, name, markdown, supportingFiles, skillsDir }) {
  const userDirectory = getUserSkillsDirectory(userId, skillsDir)
  await mkdir(skillsDir, { recursive: true })
  if (!await existingSafeDirectory(skillsDir)) throw new Error('The skills root must be a real directory.')
  const usersDirectory = path.join(skillsDir, 'users')
  await mkdir(usersDirectory, { recursive: true })
  if (!await existingSafeDirectory(usersDirectory)) throw new Error('The skills users folder must be a real directory.')
  await mkdir(userDirectory, { recursive: true })
  if (!await existingSafeDirectory(userDirectory)) throw new Error('The personal skills folder must be a real directory.')
  const skillDirectory = path.join(userDirectory, name)
  try {
    await mkdir(skillDirectory)
  } catch (error) {
    if (error.code === 'EEXIST') throw httpError(409, `Skill "${name}" is already installed.`)
    throw error
  }
  const temporary = path.join(skillDirectory, `.SKILL-${randomUUID()}.tmp`)
  const target = path.join(skillDirectory, 'SKILL.md')
  try {
    await writeFile(temporary, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await link(temporary, target)
    await unlink(temporary)
    for (const file of supportingFiles) {
      const filePath = path.join(skillDirectory, ...file.path.split('/'))
      const parent = path.dirname(filePath)
      await mkdir(parent, { recursive: true })
      await writeFile(filePath, file.content, { flag: 'wx', mode: 0o600 })
    }
    return target
  } catch (error) {
    await rm(temporary, { force: true })
    await rm(skillDirectory, { recursive: true, force: true })
    throw error
  }
}

function publicSkill(skill, overrides) {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    permissions: [...skill.permissions],
    tools: [...skill.tools],
    creates: [...(skill.creates || ['text'])],
    dangerous: skill.dangerous,
    ...overrides,
  }
}

function contentHash(value) {
  return createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex')
}

function persistedSource(source) {
  return source === 'create-skill' || source === 'biz' ? 'biz' : 'upload'
}

function displaySource(source) {
  return persistedSource(source) === 'biz' ? 'Biz' : 'Uploaded'
}

function isSkillName(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function normalizeSupportingFiles(files) {
  if (!Array.isArray(files) || files.length > 8) throw httpError(400, 'A skill may contain at most 8 supporting files.')
  let totalBytes = 0
  return files.map((file) => {
    const parts = typeof file?.path === 'string' ? file.path.split('/') : []
    if (parts.length < 2 || !['scripts', 'references', 'assets'].includes(parts[0]) ||
      parts.some((part) => !part || part === '.' || part === '..' || !/^[a-z0-9._ -]{1,128}$/i.test(part)) ||
      file.path.length > 512 || file.path.includes('\\') || !Buffer.isBuffer(file.content)) {
      throw httpError(400, 'Skill supporting files must be safe files inside scripts/, references/, or assets/.')
    }
    if (file.content.length > 2 * 1024 * 1024 || totalBytes + file.content.length > 4 * 1024 * 1024) {
      throw httpError(413, 'Skill supporting files are limited to 4 MiB total and 2 MiB per file.')
    }
    totalBytes += file.content.length
    return { path: file.path, content: file.content }
  })
}

function encodeSupportingFiles(files) {
  return files.map(({ path: filePath, content }) => ({ path: filePath, content: content.toString('base64') }))
}

function decodeSupportingFiles(files) {
  if (!Array.isArray(files)) return []
  return files.map(({ path: filePath, content }) => ({
    path: filePath,
    content: Buffer.from(content, 'base64'),
  }))
}
