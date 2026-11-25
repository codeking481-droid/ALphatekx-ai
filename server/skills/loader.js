import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { getTool, listTools } from '../tools/registry.js'
import { log } from '../observability/logger.js'

export const MAX_SKILL_BYTES = 32 * 1024
const VALID_PERMISSIONS = new Set(['tool:read', 'tool:approved'])
const DANGEROUS_TOOLS = new Set(['file_write', 'skill_create', 'run_code', 'shell'])
const BUILTIN_TOOL_IDS = new Set(['web_search', 'file_read', 'file_list', 'file_write'])
const REQUIRED_SECTIONS = ['when to use', 'steps', 'examples', 'what not to do']

export function parseSkillMarkdown(markdown) {
  try {
    return parseSkillMarkdownContent(markdown)
  } catch (error) {
    if (error.status) throw error
    throw Object.assign(error, { status: 400 })
  }
}

function parseSkillMarkdownContent(markdown) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > MAX_SKILL_BYTES) {
    throw new Error(`SKILL.md must be UTF-8 text no larger than ${MAX_SKILL_BYTES} bytes.`)
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown)
  if (!match) throw new Error('SKILL.md must begin with a YAML frontmatter block.')

  const frontmatter = parseFrontmatter(match[1])
  const allowedFields = new Set(['name', 'description', 'version', 'permissions', 'tools'])
  if (Object.keys(frontmatter).some((key) => !allowedFields.has(key))) {
    throw new Error('SKILL.md frontmatter contains an unsupported field.')
  }
  const { name, description, version, permissions, tools } = frontmatter
  if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error('Skill name must be a lowercase hyphenated slug.')
  }
  if (typeof description !== 'string' || description.trim().length < 12 || description.length > 300) {
    throw new Error('Skill description must be between 12 and 300 characters.')
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version)) {
    throw new Error('Skill version must use semantic version format, such as 1.0.0.')
  }
  if (!Array.isArray(tools) || tools.length < 1 || tools.length > 12 || new Set(tools).size !== tools.length) {
    throw new Error('Skill tools must list between 1 and 12 unique registered tool IDs.')
  }
  for (const id of tools) {
    if (typeof id !== 'string' || !getTool(id)) {
      throw new Error(`Skill requests an unavailable tool: ${String(id)}.`)
    }
  }
  if (!Array.isArray(permissions) || new Set(permissions).size !== permissions.length ||
    permissions.some((permission) => !VALID_PERMISSIONS.has(permission))) {
    throw new Error('Skill permissions must list unique supported permissions.')
  }
  const requiredPermissions = new Set(tools.flatMap((id) => getTool(id).permissions))
  if (permissions.length !== requiredPermissions.size ||
    permissions.some((permission) => !requiredPermissions.has(permission))) {
    throw new Error('Skill permissions must exactly match the permissions required by its allowed tools.')
  }

  const body = match[2].trim()
  if (Buffer.byteLength(body, 'utf8') < 40 ||
    REQUIRED_SECTIONS.some((section) => !new RegExp(`^#{1,3}\\s+${section}\\s*$`, 'im').test(body))) {
    throw new Error('Skill body must include When to use, Steps, Examples, and What not to do sections.')
  }
  return {
    name,
    description: description.trim(),
    version,
    permissions: [...permissions],
    tools: [...tools],
    body,
    markdown,
    dangerous: tools.some((id) => DANGEROUS_TOOLS.has(id)),
  }
}

export function parseFrontmatter(source) {
  const result = {}
  let activeList = null
  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue
    const listItem = /^\s+-\s+(.+?)\s*$/.exec(rawLine)
    if (listItem) {
      if (!activeList) throw new Error('Frontmatter list item has no field.')
      result[activeList].push(parseScalar(listItem[1]))
      continue
    }
    const field = /^([a-z_]+):(?:\s*(.*))?$/.exec(rawLine)
    if (!field) throw new Error('Skill frontmatter must use simple YAML key/value fields and lists.')
    if (Object.hasOwn(result, field[1])) throw new Error(`Duplicate frontmatter field: ${field[1]}.`)
    activeList = ['permissions', 'tools'].includes(field[1]) && !field[2] ? field[1] : null
    result[field[1]] = activeList ? [] : parseScalar(field[2] || '')
  }
  return result
}

export function matchSkill(message, skills) {
  const requestTokens = tokenize(message)
  if (!requestTokens.size) return null
  let best = null
  let bestScore = 0
  for (const skill of skills) {
    if (!skill.enabled) continue
    const skillTokens = tokenize(`${skill.name.replace(/-/g, ' ')} ${skill.description}`)
    let score = 0
    for (const token of requestTokens) {
      if (skillTokens.has(token)) score += token.length >= 7 ? 2 : 1
    }
    if (score > bestScore) {
      best = skill
      bestScore = score
    }
  }
  return bestScore >= 2 ? best : null
}

export function getUserSkillsDirectory(userId, skillsDir = config.skillsDir) {
  if (typeof userId !== 'string' || !userId.trim()) throw new TypeError('A user ID is required for personal skills.')
  const userHash = createHash('sha256').update(userId).digest('hex')
  return path.join(skillsDir, 'users', userHash)
}

export function getSkillAllowedTools(skill, fallback = false) {
  if (skill) return [...skill.tools]
  return fallback ? listTools().filter(({ id }) => BUILTIN_TOOL_IDS.has(id)).map(({ id }) => id) : []
}

export async function initializeSkillLoader({ skillsDir = config.skillsDir } = {}) {
  await mkdir(skillsDir, { recursive: true })
  const root = await lstat(skillsDir)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The skills root must be a real directory.')
  const results = await scanDirectory(skillsDir, { includeUserFolders: true })
  log('info', 'skills.loader.initialized', { validSkills: results.valid, invalidSkills: results.invalid })
  return results
}

export async function getAvailableSkills({ userId, database, skillsDir = config.skillsDir } = {}) {
  if (!userId) throw new TypeError('A user ID is required to list skills.')
  await mkdir(skillsDir, { recursive: true })
  const root = await lstat(skillsDir)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The skills root must be a real directory.')

  const bundled = await scanDirectory(skillsDir, { skipUsers: true, skillsDir })
  const personalRoot = getUserSkillsDirectory(userId, skillsDir)
  const usersDirectory = path.join(skillsDir, 'users')
  if (await existingSafeDirectory(usersDirectory)) await existingSafeDirectory(personalRoot)
  const personal = await scanDirectory(personalRoot, { skillsDir, missingOk: true })
  const { rows } = await database.query(
    'SELECT name, enabled FROM user_skills WHERE user_id = $1',
    [userId],
  )
  const enabledByName = new Map(rows.map((row) => [row.name, row.enabled]))
  const skills = []
  for (const skill of bundled.skills) {
    const builtin = skill.name === 'create-skill'
    skills.push({
      ...skill,
      builtin,
      bundled: !builtin,
      enabled: builtin || enabledByName.get(skill.name) === true,
    })
  }
  const bundledNames = new Set(skills.map(({ name }) => name))
  for (const skill of personal.skills) {
    if (bundledNames.has(skill.name)) {
      log('error', 'skills.loader.duplicate_skill_name', { name: skill.name })
      continue
    }
    skills.push({
      ...skill,
      builtin: false,
      bundled: false,
      enabled: enabledByName.get(skill.name) === true,
    })
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name))
}

export async function existingSafeDirectory(directory) {
  try {
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skills directory must be a real directory.')
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export async function scanDirectory(directory, {
  includeUserFolders = false,
  skipUsers = false,
  missingOk = false,
  skillsDir = config.skillsDir,
} = {}) {
  let entries
  try {
    const directoryStat = await lstat(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Skills directory must be a real directory.')
    }
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (missingOk && error.code === 'ENOENT') return { skills: [], valid: 0, invalid: 0 }
    throw error
  }
  const skills = []
  let invalid = 0
  for (const entry of entries) {
    if (entry.name === 'users' && skipUsers) continue
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (entry.name === 'users') {
      if (includeUserFolders) {
        const usersDirectory = path.join(directory, entry.name)
        let userEntries
        try {
          userEntries = await readdir(usersDirectory, { withFileTypes: true })
        } catch (error) {
          log('error', 'skills.loader.users_scan_failed', {
            path: path.relative(skillsDir, usersDirectory),
            error: { name: error.name, message: error.message },
          })
          continue
        }
        for (const userEntry of userEntries) {
          if (!userEntry.isDirectory() || userEntry.isSymbolicLink()) continue
          try {
            const userSkills = await scanDirectory(path.join(usersDirectory, userEntry.name), { skillsDir })
            skills.push(...userSkills.skills)
            invalid += userSkills.invalid
          } catch (error) {
            invalid += 1
            log('error', 'skills.loader.user_scan_failed', {
              path: path.relative(skillsDir, path.join(usersDirectory, userEntry.name)),
              error: { name: error.name, message: error.message },
            })
          }
        }
      }
      continue
    }
    const folder = path.join(directory, entry.name)
    try {
      const skillFile = path.join(folder, 'SKILL.md')
      const fileStat = await lstat(skillFile)
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_SKILL_BYTES) {
        throw new Error('SKILL.md must be a regular file within the size limit.')
      }
      const markdown = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(skillFile))
      const parsed = parseSkillMarkdown(markdown)
      if (parsed.name !== entry.name) throw new Error('Skill folder name must match frontmatter name.')
      skills.push({
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        permissions: parsed.permissions,
        tools: parsed.tools,
        body: parsed.body,
        markdown: parsed.markdown,
        dangerous: parsed.dangerous,
        sourcePath: path.relative(skillsDir, skillFile),
      })
    } catch (error) {
      invalid += 1
      log('error', 'skills.loader.invalid_skill', {
        path: path.relative(skillsDir, folder),
        error: { name: error.name, message: error.message },
      })
    }
  }
  return { skills, valid: skills.length, invalid }
}

function parseScalar(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch (cause) {
      throw new Error('Invalid quoted frontmatter value.', { cause })
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return value.trim()
}

function tokenize(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9+.-]{1,}/g) || [])
}
